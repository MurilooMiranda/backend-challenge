import { Migration } from '@mikro-orm/migrations';

export class Migration20261014InitialSchema extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid           PRIMARY KEY,
        player_id   text           NOT NULL,
        currency    char(3)        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance     numeric(20, 2) NOT NULL CHECK (balance >= 0),
        version     integer        NOT NULL CHECK (version >= 1),
        created_at  timestamptz    NOT NULL,
        updated_at  timestamptz    NOT NULL,
        CONSTRAINT wallets_player_currency_uq UNIQUE (player_id, currency),
        CONSTRAINT wallets_id_currency_uq     UNIQUE (id, currency)
      );
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                 uuid           PRIMARY KEY,
        provider_id                        text           NOT NULL,
        external_transaction_id            text           NOT NULL,
        idempotency_key                    text           NOT NULL,
        payload_hash                       text           NOT NULL,
        wallet_id                          uuid           NOT NULL REFERENCES wallets (id) DEFERRABLE INITIALLY DEFERRED,
        player_id                          text           NOT NULL,
        round_id                           text           NOT NULL,
        game_id                            text           NOT NULL,
        kind                               text           NOT NULL
          CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount                             numeric(20, 2) NOT NULL CHECK (amount >= 0),
        currency                           char(3)        NOT NULL,
        reference_external_transaction_id  text,
        reference_transaction_id           uuid           REFERENCES wager_transactions (id) DEFERRABLE INITIALLY DEFERRED,
        status                             text           NOT NULL
          CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code                       text,
        resulting_balance                  numeric(20, 2),
        reference_attempts                 integer        NOT NULL DEFAULT 0 CHECK (reference_attempts >= 0),
        next_reference_check_at            timestamptz,
        processed_at                       timestamptz,
        created_at                         timestamptz    NOT NULL,
        CONSTRAINT wager_tx_idempotency_key_uq   UNIQUE (idempotency_key),
        CONSTRAINT wager_tx_provider_external_uq UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_tx_reference_required CHECK (
          kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL
        ),
        CONSTRAINT wager_tx_failure_code_iff_failed CHECK (
          (status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)
        ),
        CONSTRAINT wager_tx_processed_at_iff_terminal CHECK (
          (status IN ('PROCESSED', 'REJECTED', 'FAILED')) = (processed_at IS NOT NULL)
        )
      );
    `);

    // No máximo uma reversão PROCESSED por transação de referência, seja REFUND ou ROLLBACK
    // (ADR 0010). Reversões rejeitadas não entram no índice e não bloqueiam uma válida depois.
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_single_reversal_uq
        ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED';
    `);

    this.addSql(`
      CREATE INDEX wager_tx_pending_reference_due_idx
        ON wager_transactions (next_reference_check_at)
        WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`CREATE INDEX wager_tx_wallet_idx ON wager_transactions (wallet_id);`);

    this.addSql(`
      CREATE FUNCTION wager_tx_guard_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager_transactions rows cannot be deleted'
            USING ERRCODE = 'restrict_violation';
        END IF;
        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          RAISE EXCEPTION 'wager_transaction % is terminal (%)', OLD.id, OLD.status
            USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END $$;
    `);
    this.addSql(`
      CREATE TRIGGER wager_tx_guard_terminal
        BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_tx_guard_terminal();
    `);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid           PRIMARY KEY,
        sequence        bigint         GENERATED ALWAYS AS IDENTITY UNIQUE,
        wallet_id       uuid           NOT NULL,
        transaction_id  uuid           NOT NULL REFERENCES wager_transactions (id) DEFERRABLE INITIALLY DEFERRED,
        direction       text           NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
        amount          numeric(20, 2) NOT NULL CHECK (amount > 0),
        currency        char(3)        NOT NULL,
        balance_before  numeric(20, 2) NOT NULL CHECK (balance_before >= 0),
        balance_after   numeric(20, 2) NOT NULL CHECK (balance_after >= 0),
        created_at      timestamptz    NOT NULL,
        CONSTRAINT ledger_wallet_currency_fk
          FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency) DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT ledger_one_entry_per_tx_wallet_uq UNIQUE (transaction_id, wallet_id),
        CONSTRAINT ledger_balanced CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount)
        )
      );
    `);
    this.addSql(
      `CREATE INDEX ledger_wallet_sequence_idx ON wallet_ledger_entries (wallet_id, sequence);`,
    );

    this.addSql(`
      CREATE FUNCTION ledger_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only (% not allowed)', TG_OP
          USING ERRCODE = 'restrict_violation';
      END $$;
    `);
    this.addSql(`
      CREATE TRIGGER ledger_append_only
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation();
    `);

    this.addSql(`
      CREATE FUNCTION ledger_assert_chain() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE previous numeric(20, 2);
      BEGIN
        SELECT balance_after INTO previous
          FROM wallet_ledger_entries
         WHERE wallet_id = NEW.wallet_id
         ORDER BY sequence DESC
         LIMIT 1;
        IF NEW.balance_before <> COALESCE(previous, 0) THEN
          RAISE EXCEPTION 'ledger chain broken for wallet %: expected balance_before %, got %',
            NEW.wallet_id, COALESCE(previous, 0), NEW.balance_before
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$;
    `);
    this.addSql(`
      CREATE TRIGGER ledger_assert_chain
        BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_assert_chain();
    `);

    // Constraint triggers deferidas rodam no COMMIT, não a cada instrução. Dentro da transação, o
    // saldo da wallet e o novo lançamento são gravados em instruções separadas e ficam diferentes
    // por um instante; a comparação só faz sentido com os dois gravados. Há um trigger em cada
    // tabela para pegar também quem altera só um dos lados.
    this.addSql(`
      CREATE FUNCTION wallet_assert_matches_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        target uuid;
        stored numeric(20, 2);
        last_after numeric(20, 2);
      BEGIN
        IF TG_TABLE_NAME = 'wallets' THEN
          target := NEW.id;
        ELSE
          target := NEW.wallet_id;
        END IF;
        SELECT balance INTO stored FROM wallets WHERE id = target;
        SELECT balance_after INTO last_after
          FROM wallet_ledger_entries
         WHERE wallet_id = target
         ORDER BY sequence DESC
         LIMIT 1;
        IF stored <> COALESCE(last_after, 0) THEN
          RAISE EXCEPTION 'wallet % balance % does not match ledger %',
            target, stored, COALESCE(last_after, 0)
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallet_balance_matches_ledger
        AFTER INSERT OR UPDATE OF balance ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallet_assert_matches_ledger();
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER ledger_matches_wallet_balance
        AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallet_assert_matches_ledger();
    `);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name  text        NOT NULL,
        message_id     text        NOT NULL,
        payload_hash   text        NOT NULL,
        received_at    timestamptz NOT NULL,
        processed_at   timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id               uuid        PRIMARY KEY,
        sequence         bigint      GENERATED ALWAYS AS IDENTITY UNIQUE,
        aggregate_id     text        NOT NULL,
        event_type       text        NOT NULL,
        payload          jsonb       NOT NULL,
        occurred_at      timestamptz NOT NULL,
        attempts         integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at  timestamptz NOT NULL,
        published_at     timestamptz,
        last_error       text
      );
    `);
    this.addSql(`
      CREATE INDEX outbox_pending_due_idx
        ON outbox_messages (next_attempt_at, sequence)
        WHERE published_at IS NULL;
    `);
  }

  override down(): void {
    this.addSql('DROP TABLE IF EXISTS outbox_messages;');
    this.addSql('DROP TABLE IF EXISTS inbox_messages;');
    this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries;');
    this.addSql('DROP TABLE IF EXISTS wager_transactions;');
    this.addSql('DROP TABLE IF EXISTS wallets;');
    this.addSql('DROP FUNCTION IF EXISTS wallet_assert_matches_ledger();');
    this.addSql('DROP FUNCTION IF EXISTS ledger_assert_chain();');
    this.addSql('DROP FUNCTION IF EXISTS ledger_forbid_mutation();');
    this.addSql('DROP FUNCTION IF EXISTS wager_tx_guard_terminal();');
  }
}
