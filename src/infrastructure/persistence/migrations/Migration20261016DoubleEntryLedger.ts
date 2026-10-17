import { Migration } from '@mikro-orm/migrations';

export class Migration20261016DoubleEntryLedger extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE ledger_accounts (
        code         text        PRIMARY KEY,
        kind         text        NOT NULL CHECK (kind IN ('PLAYER_WALLET', 'HOUSE', 'FUNDING')),
        currency     char(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        wallet_id    uuid        UNIQUE,
        provider_id  text,
        created_at   timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ledger_accounts_code_currency_uq UNIQUE (code, currency),
        CONSTRAINT ledger_accounts_wallet_currency_fk
          FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency) DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT ledger_accounts_wallet_iff_player CHECK ((kind = 'PLAYER_WALLET') = (wallet_id IS NOT NULL)),
        CONSTRAINT ledger_accounts_provider_iff_house CHECK ((kind = 'HOUSE') = (provider_id IS NOT NULL))
      );
    `);

    this.addSql(`
      CREATE TABLE journal_entries (
        id              uuid        PRIMARY KEY,
        transaction_id  uuid        NOT NULL REFERENCES wager_transactions (id) DEFERRABLE INITIALLY DEFERRED,
        currency        char(3)     NOT NULL,
        created_at      timestamptz NOT NULL,
        CONSTRAINT journal_entries_transaction_uq UNIQUE (transaction_id),
        CONSTRAINT journal_entries_id_currency_uq UNIQUE (id, currency)
      );
    `);

    this.addSql(`
      CREATE TABLE journal_postings (
        id                uuid           PRIMARY KEY,
        journal_entry_id  uuid           NOT NULL,
        account_code      text           NOT NULL,
        direction         text           NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
        amount            numeric(20, 2) NOT NULL CHECK (amount > 0),
        currency          char(3)        NOT NULL,
        CONSTRAINT journal_postings_entry_fk
          FOREIGN KEY (journal_entry_id, currency) REFERENCES journal_entries (id, currency) DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT journal_postings_account_fk
          FOREIGN KEY (account_code, currency) REFERENCES ledger_accounts (code, currency) DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT journal_postings_one_per_account_uq UNIQUE (journal_entry_id, account_code)
      );
    `);
    this.addSql(`CREATE INDEX journal_postings_account_idx ON journal_postings (account_code);`);

    // Backfill: recria no razão os lançamentos que já existiam no ledger das wallets, para que os
    // triggers abaixo (que exigem os dois lados) valham também para o histórico.
    this.addSql(`
      INSERT INTO ledger_accounts (code, kind, currency, wallet_id)
      SELECT 'PLAYER:' || id, 'PLAYER_WALLET', currency, id FROM wallets;
    `);
    this.addSql(`
      INSERT INTO ledger_accounts (code, kind, currency, provider_id)
      SELECT DISTINCT 'HOUSE:' || t.provider_id || ':' || e.currency, 'HOUSE', e.currency, t.provider_id
        FROM wallet_ledger_entries e
        JOIN wager_transactions t ON t.id = e.transaction_id
       WHERE t.kind <> 'OPENING';
    `);
    this.addSql(`
      INSERT INTO ledger_accounts (code, kind, currency)
      SELECT DISTINCT 'FUNDING:' || e.currency, 'FUNDING', e.currency
        FROM wallet_ledger_entries e
        JOIN wager_transactions t ON t.id = e.transaction_id
       WHERE t.kind = 'OPENING';
    `);
    this.addSql(`
      INSERT INTO journal_entries (id, transaction_id, currency, created_at)
      SELECT gen_random_uuid(), transaction_id, currency, created_at FROM wallet_ledger_entries;
    `);
    this.addSql(`
      INSERT INTO journal_postings (id, journal_entry_id, account_code, direction, amount, currency)
      SELECT gen_random_uuid(), j.id, 'PLAYER:' || e.wallet_id, e.direction, e.amount, e.currency
        FROM journal_entries j
        JOIN wallet_ledger_entries e ON e.transaction_id = j.transaction_id
      UNION ALL
      SELECT gen_random_uuid(),
             j.id,
             CASE WHEN t.kind = 'OPENING' THEN 'FUNDING:' || e.currency
                  ELSE 'HOUSE:' || t.provider_id || ':' || e.currency END,
             CASE e.direction WHEN 'DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END,
             e.amount,
             e.currency
        FROM journal_entries j
        JOIN wallet_ledger_entries e ON e.transaction_id = j.transaction_id
        JOIN wager_transactions t ON t.id = e.transaction_id;
    `);

    this.addSql(`
      CREATE FUNCTION journal_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '% is append-only (% not allowed)', TG_TABLE_NAME, TG_OP
          USING ERRCODE = 'restrict_violation';
      END $$;
    `);
    for (const table of ['ledger_accounts', 'journal_entries', 'journal_postings']) {
      this.addSql(`
        CREATE TRIGGER ${table}_append_only
          BEFORE UPDATE OR DELETE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION journal_forbid_mutation();
      `);
    }

    this.addSql(`
      CREATE FUNCTION journal_assert_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        target uuid;
        postings integer;
        debits numeric(20, 2);
        credits numeric(20, 2);
      BEGIN
        IF TG_TABLE_NAME = 'journal_entries' THEN
          target := NEW.id;
        ELSE
          target := NEW.journal_entry_id;
        END IF;
        SELECT count(*),
               COALESCE(sum(amount) FILTER (WHERE direction = 'DEBIT'), 0),
               COALESCE(sum(amount) FILTER (WHERE direction = 'CREDIT'), 0)
          INTO postings, debits, credits
          FROM journal_postings
         WHERE journal_entry_id = target;
        IF postings < 2 OR debits <> credits THEN
          RAISE EXCEPTION 'journal entry % is unbalanced (% postings, debits %, credits %)',
            target, postings, debits, credits
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER journal_entries_balanced
        AFTER INSERT ON journal_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION journal_assert_balanced();
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER journal_postings_balanced
        AFTER INSERT ON journal_postings
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION journal_assert_balanced();
    `);

    // Os dois triggers seguintes amarram o ledger da wallet (subledger) ao razão nos dois sentidos:
    // todo lançamento da wallet tem um posting igual na conta do jogador, e vice-versa. Assim o
    // saldo da wallet e o saldo contábil do jogador não conseguem divergir.
    this.addSql(`
      CREATE FUNCTION wallet_entry_assert_journal() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
            FROM journal_entries j
            JOIN journal_postings p ON p.journal_entry_id = j.id
            JOIN ledger_accounts a ON a.code = p.account_code
           WHERE j.transaction_id = NEW.transaction_id
             AND a.wallet_id = NEW.wallet_id
             AND p.direction = NEW.direction
             AND p.amount = NEW.amount
        ) THEN
          RAISE EXCEPTION 'wallet ledger entry % has no matching journal posting', NEW.id
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallet_entry_has_journal
        AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallet_entry_assert_journal();
    `);

    this.addSql(`
      CREATE FUNCTION player_posting_assert_wallet_entry() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM ledger_accounts WHERE code = NEW.account_code AND kind = 'PLAYER_WALLET'
        ) AND NOT EXISTS (
          SELECT 1
            FROM journal_entries j
            JOIN wallet_ledger_entries e ON e.transaction_id = j.transaction_id
            JOIN ledger_accounts a ON a.wallet_id = e.wallet_id
           WHERE j.id = NEW.journal_entry_id
             AND a.code = NEW.account_code
             AND e.direction = NEW.direction
             AND e.amount = NEW.amount
        ) THEN
          RAISE EXCEPTION 'player posting % has no matching wallet ledger entry', NEW.id
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER player_posting_has_wallet_entry
        AFTER INSERT ON journal_postings
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION player_posting_assert_wallet_entry();
    `);
  }

  override down(): void {
    this.addSql('DROP TRIGGER IF EXISTS wallet_entry_has_journal ON wallet_ledger_entries;');
    this.addSql('DROP TABLE IF EXISTS journal_postings;');
    this.addSql('DROP TABLE IF EXISTS journal_entries;');
    this.addSql('DROP TABLE IF EXISTS ledger_accounts;');
    this.addSql('DROP FUNCTION IF EXISTS player_posting_assert_wallet_entry();');
    this.addSql('DROP FUNCTION IF EXISTS wallet_entry_assert_journal();');
    this.addSql('DROP FUNCTION IF EXISTS journal_assert_balanced();');
    this.addSql('DROP FUNCTION IF EXISTS journal_forbid_mutation();');
  }
}
