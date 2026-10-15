import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  IdempotencyConflictError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '@/application/errors';
import { GetTrialBalance } from '@/application/ledger/get-trial-balance';
import { ReconcileWallet } from '@/application/wallets/reconcile-wallet';
import { FailureCode } from '@/domain/wagering/failure-code';
import { MikroOrmWageringQueries } from '@/infrastructure/persistence/mikro-orm-wagering-queries';
import { WagerTransactionStatus as Status } from '@/domain/wagering/wager-transaction';
import { createTestOrm, resetDatabase } from '../support/database';
import {
  countRows,
  createUseCases,
  expectBalanceMatchesLedger,
  wagerCommand,
} from '../support/wagering';

let orm: MikroORM;
let useCases: ReturnType<typeof createUseCases>;

beforeAll(async () => {
  orm = await createTestOrm();
  useCases = createUseCases(orm);
});

beforeEach(async () => {
  await resetDatabase(orm);
});

afterAll(async () => {
  await orm.close();
});

async function openWallet(amount = '100.00', playerId: string = crypto.randomUUID()) {
  return useCases.openWallet.execute({
    playerId,
    initialBalance: { amount, currency: 'BRL' },
    correlationId: 'test',
  });
}

describe('OpenWallet', () => {
  it('creates the wallet, the OPENING transaction, its ledger entry and an outbox event atomically', async () => {
    const wallet = await openWallet('1000.00');

    expect(wallet.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
    expect(
      await countRows(orm, 'wager_transactions', `wallet_id = ? AND kind = 'OPENING'`, [wallet.id]),
    ).toBe(1);
    expect(await countRows(orm, 'wallet_ledger_entries', 'wallet_id = ?', [wallet.id])).toBe(1);
    expect(await countRows(orm, 'outbox_messages', `event_type = 'WalletBalanceChanged'`)).toBe(1);
    await expectBalanceMatchesLedger(orm, wallet.id);
  });

  it('a zero balance wallet has no OPENING transaction', async () => {
    const wallet = await openWallet('0.00');
    expect(await countRows(orm, 'wager_transactions', 'wallet_id = ?', [wallet.id])).toBe(0);
    await expectBalanceMatchesLedger(orm, wallet.id);
  });

  it('rejects a second wallet for the same player and currency', async () => {
    const wallet = await openWallet('10.00');
    await expect(openWallet('5.00', wallet.playerId)).rejects.toThrow(WalletAlreadyExistsError);
  });
});

describe('ProcessWagerTransaction', () => {
  it('processes a BET, debits the wallet and writes ledger + outbox in the same transaction', async () => {
    const wallet = await openWallet('1000.00');
    const result = await useCases.processWager.execute(wagerCommand(wallet.id, wallet.playerId));

    expect(result.status).toBe(Status.Processed);
    expect(result.balance).toEqual({ amount: '975.00', currency: 'BRL' });
    expect(result.idempotentReplay).toBe(false);
    expect(
      await countRows(
        orm,
        'outbox_messages',
        `aggregate_id = ? AND event_type IN ('WagerTransactionProcessed', 'WalletBalanceChanged')`,
        [wallet.id],
      ),
    ).toBe(3);
    await expectBalanceMatchesLedger(orm, wallet.id);
  });

  it('an identical retry is a replay with the original result', async () => {
    const wallet = await openWallet('100.00');
    const command = wagerCommand(wallet.id, wallet.playerId);

    const first = await useCases.processWager.execute(command);
    await useCases.processWager.execute(wagerCommand(wallet.id, wallet.playerId));
    const replay = await useCases.processWager.execute(command);

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(
      await countRows(orm, 'wallet_ledger_entries', `wallet_id = ? AND direction = 'DEBIT'`, [
        wallet.id,
      ]),
    ).toBe(2);
  });

  it('same idempotency key with a different payload is a conflict', async () => {
    const wallet = await openWallet('100.00');
    const command = wagerCommand(wallet.id, wallet.playerId);
    await useCases.processWager.execute(command);

    await expect(
      useCases.processWager.execute({ ...command, money: { amount: '30.00', currency: 'BRL' } }),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it('transport metadata does not change the payload hash', async () => {
    const wallet = await openWallet('100.00');
    const command = wagerCommand(wallet.id, wallet.playerId);
    await useCases.processWager.execute(command);

    const replay = await useCases.processWager.execute({ ...command, correlationId: 'another' });
    expect(replay.idempotentReplay).toBe(true);
  });

  it('a rejected BET is persisted as REJECTED without ledger entry', async () => {
    const wallet = await openWallet('10.00');
    const result = await useCases.processWager.execute(
      wagerCommand(wallet.id, wallet.playerId, { money: { amount: '80.00', currency: 'BRL' } }),
    );

    expect(result.status).toBe(Status.Rejected);
    expect(result.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(result.balance).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(
      await countRows(orm, 'wallet_ledger_entries', `wallet_id = ? AND direction = 'DEBIT'`, [
        wallet.id,
      ]),
    ).toBe(0);
    expect(await countRows(orm, 'outbox_messages', `event_type = 'WagerTransactionRejected'`)).toBe(
      1,
    );
  });

  it('a currency mismatch is rejected without leaking the wallet balance', async () => {
    const wallet = await openWallet('10.00');
    const result = await useCases.processWager.execute(
      wagerCommand(wallet.id, wallet.playerId, { money: { amount: '1.00', currency: 'USD' } }),
    );
    expect(result.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(result.balance).toBeNull();
  });

  it('an unknown wallet is not persisted', async () => {
    await expect(
      useCases.processWager.execute(wagerCommand(crypto.randomUUID(), 'player-x')),
    ).rejects.toThrow(WalletNotFoundError);
    expect(await countRows(orm, 'wager_transactions', 'true')).toBe(0);
  });

  it('REFUND of a processed BET restores the balance', async () => {
    const wallet = await openWallet('100.00');
    const bet = wagerCommand(wallet.id, wallet.playerId);
    await useCases.processWager.execute(bet);

    const refund = await useCases.processWager.execute(
      wagerCommand(wallet.id, wallet.playerId, {
        kind: 'REFUND',
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );

    expect(refund.status).toBe(Status.Processed);
    expect(refund.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    await expectBalanceMatchesLedger(orm, wallet.id);
  });

  it('a ROLLBACK delivered before its reference waits as PENDING_REFERENCE', async () => {
    const wallet = await openWallet('100.00');
    const result = await useCases.processWager.execute(
      wagerCommand(wallet.id, wallet.playerId, {
        kind: 'ROLLBACK',
        referenceExternalTransactionId: 'not-yet-arrived',
      }),
    );

    expect(result.status).toBe(Status.PendingReference);
    expect(result.balance).toBeNull();
    expect(
      await countRows(orm, 'outbox_messages', `event_type = 'WagerTransactionPendingReference'`),
    ).toBe(1);
    await expectBalanceMatchesLedger(orm, wallet.id);
  });
});

describe('concurrency', () => {
  it('section 8: two concurrent 80.00 bets on 100.00 → exactly one processed, balance 20.00', async () => {
    const wallet = await openWallet('100.00');
    const amount = { amount: '80.00', currency: 'BRL' };

    const results = await Promise.all([
      useCases.processWager.execute(wagerCommand(wallet.id, wallet.playerId, { money: amount })),
      useCases.processWager.execute(wagerCommand(wallet.id, wallet.playerId, { money: amount })),
    ]);

    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([Status.Processed, Status.Rejected]);
    expect(results.find((r) => r.status === Status.Rejected)!.failureCode).toBe(
      FailureCode.InsufficientFunds,
    );
    expect(
      await countRows(orm, 'wallet_ledger_entries', `wallet_id = ? AND direction = 'DEBIT'`, [
        wallet.id,
      ]),
    ).toBe(1);

    const [row] = await orm.em.execute<{ balance: string }[]>(
      `SELECT balance FROM wallets WHERE id = ?`,
      [wallet.id],
    );
    expect(row!.balance).toBe('20.00');
    await expectBalanceMatchesLedger(orm, wallet.id);
  });

  it('the same bet sent 50 times in parallel debits exactly once', async () => {
    const wallet = await openWallet('100.00');
    const command = wagerCommand(wallet.id, wallet.playerId);

    const results = await Promise.all(
      Array.from({ length: 50 }, () => useCases.processWager.execute(command)),
    );

    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.every((r) => r.balance?.amount === '75.00')).toBe(true);
    expect(
      await countRows(orm, 'wallet_ledger_entries', `wallet_id = ? AND direction = 'DEBIT'`, [
        wallet.id,
      ]),
    ).toBe(1);
    await expectBalanceMatchesLedger(orm, wallet.id);
  });

  it('many concurrent bets on a hot wallet never overdraw it', async () => {
    const wallet = await openWallet('100.00');

    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        useCases.processWager.execute(
          wagerCommand(wallet.id, wallet.playerId, { money: { amount: '7.00', currency: 'BRL' } }),
        ),
      ),
    );

    expect(results.filter((r) => r.status === Status.Processed)).toHaveLength(14);
    const [row] = await orm.em.execute<{ balance: string }[]>(
      `SELECT balance FROM wallets WHERE id = ?`,
      [wallet.id],
    );
    expect(row!.balance).toBe('2.00');
    await expectBalanceMatchesLedger(orm, wallet.id);
  });

  it('distinct wallets are processed in parallel and stay consistent', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet('100.00')));

    await Promise.all(
      wallets.flatMap((wallet) =>
        Array.from({ length: 5 }, () =>
          useCases.processWager.execute(
            wagerCommand(wallet.id, wallet.playerId, {
              money: { amount: '10.00', currency: 'BRL' },
            }),
          ),
        ),
      ),
    );

    for (const wallet of wallets) {
      const [row] = await orm.em.execute<{ balance: string }[]>(
        `SELECT balance FROM wallets WHERE id = ?`,
        [wallet.id],
      );
      expect(row!.balance).toBe('50.00');
      await expectBalanceMatchesLedger(orm, wallet.id);
    }
  });

  it('the same idempotency key raced against two different wallets resolves to one winner', async () => {
    const [a, b] = await Promise.all([openWallet('100.00'), openWallet('100.00')]);
    const shared = wagerCommand(a!.id, a!.playerId);

    const settled = await Promise.allSettled([
      useCases.processWager.execute(shared),
      useCases.processWager.execute({ ...shared, walletId: b!.id, playerId: b!.playerId }),
    ]);

    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(IdempotencyConflictError);
    expect(
      await countRows(orm, 'wager_transactions', `idempotency_key = ?`, [shared.idempotencyKey]),
    ).toBe(1);
  });
});

describe('double-entry bookkeeping', () => {
  const trialBalance = () => new GetTrialBalance(new MikroOrmWageringQueries(orm)).execute('BRL');
  const reconcile = (walletId: string) =>
    new ReconcileWallet(new MikroOrmWageringQueries(orm)).execute(walletId);

  it('every operation kind keeps the books balanced and the player account equal to the wallet', async () => {
    const wallet = await openWallet('100.00');
    const run = (overrides: Parameters<typeof wagerCommand>[2]) =>
      useCases.processWager.execute(wagerCommand(wallet.id, wallet.playerId, overrides));

    const bet = wagerCommand(wallet.id, wallet.playerId, {
      money: { amount: '40.00', currency: 'BRL' },
    });
    await useCases.processWager.execute(bet);
    const win = wagerCommand(wallet.id, wallet.playerId, {
      kind: 'WIN',
      money: { amount: '70.00', currency: 'BRL' },
    });
    await useCases.processWager.execute(win);
    await run({ kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } });
    await run({
      kind: 'REFUND',
      money: { amount: '40.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    await run({
      kind: 'ROLLBACK',
      money: { amount: '70.00', currency: 'BRL' },
      referenceExternalTransactionId: win.externalTransactionId,
    });
    await run({ money: { amount: '999.00', currency: 'BRL' } });

    expect(await countRows(orm, 'journal_entries', 'true')).toBe(
      await countRows(orm, 'wallet_ledger_entries', 'true'),
    );

    const report = await reconcile(wallet.id);
    expect(report.consistent).toBe(true);
    expect(report.journalBalance).toEqual({ amount: '100.00', currency: 'BRL' });

    const books = await trialBalance();
    expect(books.balanced).toBe(true);
    expect(books.totalDebits).toEqual(books.totalCredits);
    expect(books.accounts.find((a) => a.kind === 'HOUSE')?.balance).toEqual({
      amount: '0.00',
      currency: 'BRL',
    });
  });

  it('concurrent traffic on many wallets keeps every journal balanced', async () => {
    const wallets = await Promise.all(Array.from({ length: 8 }, () => openWallet('100.00')));
    await Promise.all(
      wallets.flatMap((wallet, i) =>
        Array.from({ length: 6 }, (_, j) =>
          useCases.processWager.execute(
            wagerCommand(wallet.id, wallet.playerId, {
              kind: (i + j) % 3 === 0 ? 'WIN' : 'BET',
              money: { amount: '15.00', currency: 'BRL' },
            }),
          ),
        ),
      ),
    );

    const books = await trialBalance();
    expect(books.balanced).toBe(true);
    expect(books.unbalancedJournalEntries).toBe(0);
    for (const wallet of wallets) {
      expect((await reconcile(wallet.id)).consistent).toBe(true);
    }
  });
});
