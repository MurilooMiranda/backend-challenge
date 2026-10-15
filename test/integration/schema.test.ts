import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm, resetDatabase, runInTransaction } from '../support/database';

const WALLET = '00000000-0000-0000-0000-000000000001';
const OPENING_TX = '00000000-0000-0000-0000-0000000000a1';
const BET_TX = '00000000-0000-0000-0000-0000000000a2';

const sql = {
  wallet: (id = WALLET, player = 'player-1', balance = '100.00') =>
    `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
     VALUES ('${id}', '${player}', 'BRL', ${balance}, 1, now(), now())`,

  tx: (
    id: string,
    kind: string,
    amount: string,
    key: string,
    extra: Record<string, string> = {},
  ) => {
    const columns = {
      id: `'${id}'`,
      provider_id: `'provider-a'`,
      external_transaction_id: `'${key}'`,
      idempotency_key: `'provider-a:${key}'`,
      payload_hash: `'hash'`,
      wallet_id: `'${WALLET}'`,
      player_id: `'player-1'`,
      round_id: `'round-1'`,
      game_id: `'game-1'`,
      kind: `'${kind}'`,
      amount,
      currency: `'BRL'`,
      status: `'PROCESSED'`,
      processed_at: 'now()',
      created_at: 'now()',
      ...extra,
    };
    return `INSERT INTO wager_transactions (${Object.keys(columns).join(', ')})
            VALUES (${Object.values(columns).join(', ')})`;
  },

  entry: (
    id: string,
    txId: string,
    direction: string,
    amount: string,
    before: string,
    after: string,
    currency = 'BRL',
  ) =>
    `INSERT INTO wallet_ledger_entries
       (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
     VALUES ('${id}', '${WALLET}', '${txId}', '${direction}', ${amount}, '${currency}', ${before}, ${after}, now())`,
};

const uuid = (n: number) => `00000000-0000-0000-0000-${n.toString().padStart(12, '0')}`;

async function seedWalletWithBet(orm: MikroORM) {
  await runInTransaction(orm, [
    sql.wallet(),
    sql.tx(OPENING_TX, 'OPENING', '100.00', 'opening'),
    sql.entry(uuid(901), OPENING_TX, 'CREDIT', '100.00', '0.00', '100.00'),
  ]);
  await runInTransaction(orm, [
    sql.tx(BET_TX, 'BET', '25.00', 'bet-1'),
    sql.entry(uuid(902), BET_TX, 'DEBIT', '25.00', '100.00', '75.00'),
    `UPDATE wallets SET balance = 75.00, version = 2 WHERE id = '${WALLET}'`,
  ]);
}

let orm: MikroORM;

beforeAll(async () => {
  orm = await createTestOrm();
});

beforeEach(async () => {
  await resetDatabase(orm);
});

afterAll(async () => {
  await orm.close();
});

describe('migrations', () => {
  it('are reversible: down removes everything, up recreates it', async () => {
    const countTables = async () => {
      const [row] = await orm.em.execute<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM pg_tables
          WHERE schemaname = 'public' AND tablename <> 'mikro_orm_migrations'`,
      );
      return row!.n;
    };

    expect(await countTables()).toBe(5);
    await orm.migrator.down({ to: 0 });
    expect(await countTables()).toBe(0);
    await orm.migrator.up();
    expect(await countTables()).toBe(5);
  });
});

describe('wallets', () => {
  it('accepts a consistent wallet + opening + ledger entry', async () => {
    await seedWalletWithBet(orm);
    const [wallet] = await orm.em.execute<{ balance: string }[]>(
      `SELECT balance FROM wallets WHERE id = '${WALLET}'`,
    );
    expect(wallet!.balance).toBe('75.00');
  });

  it('one wallet per player + currency', async () => {
    await seedWalletWithBet(orm);
    await expect(runInTransaction(orm, [sql.wallet(uuid(2), 'player-1', '0.00')])).rejects.toThrow(
      /wallets_player_currency_uq/,
    );
  });

  it('balance can never be negative', async () => {
    await seedWalletWithBet(orm);
    await expect(
      runInTransaction(orm, [`UPDATE wallets SET balance = -1 WHERE id = '${WALLET}'`]),
    ).rejects.toThrow(/wallets_balance_check/);
  });

  it('balance cannot change without a matching ledger entry (checked at commit)', async () => {
    await seedWalletWithBet(orm);
    await expect(
      runInTransaction(orm, [`UPDATE wallets SET balance = 50.00 WHERE id = '${WALLET}'`]),
    ).rejects.toThrow(/does not match ledger/);
  });

  it('a wallet with initial balance needs its OPENING entry', async () => {
    await expect(runInTransaction(orm, [sql.wallet()])).rejects.toThrow(/does not match ledger/);
  });
});

describe('wallet_ledger_entries', () => {
  it('is append-only: UPDATE is forbidden', async () => {
    await seedWalletWithBet(orm);
    await expect(
      runInTransaction(orm, [`UPDATE wallet_ledger_entries SET amount = 1`]),
    ).rejects.toThrow(/append-only/);
  });

  it('is append-only: DELETE is forbidden', async () => {
    await seedWalletWithBet(orm);
    await expect(runInTransaction(orm, [`DELETE FROM wallet_ledger_entries`])).rejects.toThrow(
      /append-only/,
    );
  });

  it('every entry must be arithmetically balanced', async () => {
    await seedWalletWithBet(orm);
    await expect(
      runInTransaction(orm, [
        sql.tx(uuid(3), 'BET', '25.00', 'bet-2'),
        sql.entry(uuid(903), uuid(3), 'DEBIT', '25.00', '75.00', '60.00'),
      ]),
    ).rejects.toThrow(/ledger_balanced/);
  });

  it('every entry must continue the chain from the previous balance', async () => {
    await seedWalletWithBet(orm);
    await expect(
      runInTransaction(orm, [
        sql.tx(uuid(3), 'BET', '10.00', 'bet-2'),
        sql.entry(uuid(903), uuid(3), 'DEBIT', '10.00', '100.00', '90.00'),
      ]),
    ).rejects.toThrow(/ledger chain broken/);
  });

  it('at most one entry per transaction and wallet', async () => {
    await seedWalletWithBet(orm);
    await expect(
      runInTransaction(orm, [
        sql.entry(uuid(903), BET_TX, 'DEBIT', '25.00', '75.00', '50.00'),
        `UPDATE wallets SET balance = 50.00 WHERE id = '${WALLET}'`,
      ]),
    ).rejects.toThrow(/ledger_one_entry_per_tx_wallet_uq/);
  });

  it('entry currency must match the wallet currency', async () => {
    await seedWalletWithBet(orm);
    await expect(
      runInTransaction(orm, [
        sql.tx(uuid(3), 'WIN', '1.00', 'win-1'),
        sql.entry(uuid(903), uuid(3), 'CREDIT', '1.00', '75.00', '76.00', 'USD'),
      ]),
    ).rejects.toThrow(/ledger_wallet_currency_fk/);
  });

  it('balance_after can never be negative', async () => {
    await seedWalletWithBet(orm);
    await expect(
      runInTransaction(orm, [
        sql.tx(uuid(3), 'BET', '80.00', 'bet-2'),
        sql.entry(uuid(903), uuid(3), 'DEBIT', '80.00', '75.00', '-5.00'),
      ]),
    ).rejects.toThrow(/balance_after_check/);
  });
});

describe('wager_transactions', () => {
  it('idempotency key is unique', async () => {
    await seedWalletWithBet(orm);
    await expect(
      runInTransaction(orm, [
        sql.tx(uuid(3), 'BET', '1.00', 'bet-1', { external_transaction_id: `'other'` }),
      ]),
    ).rejects.toThrow(/wager_tx_idempotency_key_uq/);
  });

  it('(provider, external id) is unique', async () => {
    await seedWalletWithBet(orm);
    await expect(
      runInTransaction(orm, [
        sql.tx(uuid(3), 'BET', '1.00', 'bet-1', { idempotency_key: `'another-key'` }),
      ]),
    ).rejects.toThrow(/wager_tx_provider_external_uq/);
  });

  it('REFUND and ROLLBACK require a reference', async () => {
    await seedWalletWithBet(orm);
    await expect(
      runInTransaction(orm, [sql.tx(uuid(3), 'REFUND', '25.00', 'refund-1')]),
    ).rejects.toThrow(/wager_tx_reference_required/);
  });

  it('a terminal transaction is immutable', async () => {
    await seedWalletWithBet(orm);
    await expect(
      runInTransaction(orm, [
        `UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'X' WHERE id = '${BET_TX}'`,
      ]),
    ).rejects.toThrow(/is terminal/);
  });

  it('transactions cannot be deleted', async () => {
    await seedWalletWithBet(orm);
    await expect(
      runInTransaction(orm, [`DELETE FROM wager_transactions WHERE id = '${BET_TX}'`]),
    ).rejects.toThrow(/cannot be deleted/);
  });

  it('REJECTED requires a failure code', async () => {
    await seedWalletWithBet(orm);
    await expect(
      runInTransaction(orm, [sql.tx(uuid(3), 'BET', '500.00', 'bet-2', { status: `'REJECTED'` })]),
    ).rejects.toThrow(/wager_tx_failure_code_iff_failed/);
  });

  it('a reference can be reversed only once', async () => {
    await seedWalletWithBet(orm);
    const refund = (id: number, key: string) =>
      sql.tx(uuid(id), 'REFUND', '25.00', key, {
        reference_external_transaction_id: `'bet-1'`,
        reference_transaction_id: `'${BET_TX}'`,
      });

    await runInTransaction(orm, [
      refund(3, 'refund-1'),
      sql.entry(uuid(903), uuid(3), 'CREDIT', '25.00', '75.00', '100.00'),
      `UPDATE wallets SET balance = 100.00, version = 3 WHERE id = '${WALLET}'`,
    ]);
    await expect(
      runInTransaction(orm, [
        refund(4, 'refund-2'),
        sql.entry(uuid(904), uuid(4), 'CREDIT', '25.00', '100.00', '125.00'),
        `UPDATE wallets SET balance = 125.00, version = 4 WHERE id = '${WALLET}'`,
      ]),
    ).rejects.toThrow(/wager_tx_single_reversal_uq/);
  });
});

describe('inbox_messages', () => {
  it('(consumer, message id) is unique', async () => {
    const insert = `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
                    VALUES ('wager-consumer', 'msg-1', 'h', now())`;
    await runInTransaction(orm, [insert]);
    await expect(runInTransaction(orm, [insert])).rejects.toThrow(/inbox_messages_pkey/);
  });
});
