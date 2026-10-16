import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import fc from 'fast-check';
import { GetTrialBalance } from '@/application/ledger/get-trial-balance';
import type { ProcessWagerTransactionCommand } from '@/application/wagering/process-wager-transaction';
import { ReconcileWallet } from '@/application/wallets/reconcile-wallet';
import { FailureCode } from '@/domain/wagering/failure-code';
import { WagerTransactionStatus as Status } from '@/domain/wagering/wager-transaction';
import { MikroOrmWageringQueries } from '@/infrastructure/persistence/mikro-orm-wagering-queries';
import { createTestOrm, resetDatabase } from '../support/database';
import {
  countRows,
  createUseCases,
  expectBalanceMatchesLedger,
  wagerCommand,
} from '../support/wagering';

const NUM_RUNS = Number(process.env.FC_NUM_RUNS_DB ?? 15);
const FC_OPTIONS = {
  numRuns: NUM_RUNS,
  ...(process.env.FC_SEED ? { seed: Number(process.env.FC_SEED) } : {}),
};

let orm: MikroORM;
let useCases: ReturnType<typeof createUseCases>;

beforeAll(async () => {
  orm = await createTestOrm();
  await resetDatabase(orm);
  useCases = createUseCases(orm);
});

afterAll(async () => {
  await orm.close();
});

interface Step {
  wallet: 0 | 1;
  kind: 'BET' | 'WIN';
  cents: number;
  duplicateOf: number | null;
}

const step: fc.Arbitrary<Step> = fc.record({
  wallet: fc.constantFrom(0 as const, 1 as const),
  kind: fc.oneof(
    { weight: 3, arbitrary: fc.constant('BET' as const) },
    { weight: 1, arbitrary: fc.constant('WIN' as const) },
  ),
  cents: fc.integer({ min: 1, max: 5_000 }),
  duplicateOf: fc.option(fc.nat(), { freq: 3, nil: null }),
});

const toAmount = (cents: number) =>
  `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

async function balanceCents(walletId: string): Promise<number> {
  const [row] = await orm.em.execute<{ cents: number }[]>(
    'SELECT (balance * 100)::bigint AS cents FROM wallets WHERE id = ?',
    [walletId],
  );
  return Number(row!.cents);
}

describe('concurrency properties against the real database', () => {
  it('any concurrent mix of bets, wins and duplicates converges to the sequential model', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 20_000 }),
        fc.array(step, { minLength: 2, maxLength: 30 }),
        async (initialCents, steps) => {
          const wallets = await Promise.all(
            [0, 1].map(() =>
              useCases.openWallet.execute({
                playerId: crypto.randomUUID(),
                initialBalance: { amount: toAmount(initialCents), currency: 'BRL' },
                correlationId: 'property',
              }),
            ),
          );

          const commands: ProcessWagerTransactionCommand[] = [];
          for (const s of steps) {
            const original =
              s.duplicateOf !== null && commands.length > 0
                ? commands[s.duplicateOf % commands.length]
                : undefined;
            const wallet = wallets[s.wallet]!;
            commands.push(
              original ??
                wagerCommand(wallet.id, wallet.playerId, {
                  kind: s.kind,
                  money: { amount: toAmount(s.cents), currency: 'BRL' },
                }),
            );
          }

          const results = await Promise.all(
            commands.map((command) => useCases.processWager.execute(command)),
          );

          const firstByKey = new Map<string, (typeof results)[number]>();
          results.forEach((result, index) => {
            const key = commands[index]!.idempotencyKey;
            const seen = firstByKey.get(key);
            if (seen) {
              expect(result.transactionId).toBe(seen.transactionId);
              expect(result.status).toBe(seen.status);
            } else {
              firstByKey.set(key, result);
            }
          });
          expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(firstByKey.size);

          for (const wallet of wallets) {
            let expected = initialCents;
            for (const [key, result] of firstByKey) {
              const command = commands.find((c) => c.idempotencyKey === key)!;
              if (command.walletId !== wallet.id) continue;
              const amount = Math.round(Number(command.money.amount) * 100);
              if (result.status === Status.Processed) {
                expected += command.kind === 'WIN' ? amount : -amount;
              } else {
                expect(result.status).toBe(Status.Rejected);
                expect(result.failureCode).toBe(FailureCode.InsufficientFunds);
              }
            }
            expect(await balanceCents(wallet.id)).toBe(expected);
            expect(expected).toBeGreaterThanOrEqual(0);
            await expectBalanceMatchesLedger(orm, wallet.id);
            const report = await new ReconcileWallet(new MikroOrmWageringQueries(orm)).execute(
              wallet.id,
            );
            expect(report.consistent).toBe(true);
            expect(
              await countRows(orm, 'wager_transactions', `wallet_id = ? AND kind <> 'OPENING'`, [
                wallet.id,
              ]),
            ).toBe(
              [...firstByKey.keys()].filter(
                (k) => commands.find((c) => c.idempotencyKey === k)!.walletId === wallet.id,
              ).length,
            );
          }
        },
      ),
      FC_OPTIONS,
    );

    const books = await new GetTrialBalance(new MikroOrmWageringQueries(orm)).execute('BRL');
    expect(books.balanced).toBe(true);
  });
});
