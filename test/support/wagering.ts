import type { MikroORM } from '@mikro-orm/postgresql';
import { expect } from 'bun:test';
import type { ProcessWagerTransactionCommand } from '@/application/wagering/process-wager-transaction';
import { ProcessWagerTransaction } from '@/application/wagering/process-wager-transaction';
import { OpenWallet } from '@/application/wallets/open-wallet';
import { MikroOrmTransactionRunner } from '@/infrastructure/persistence/mikro-orm-transaction-runner';
import { SystemClock, UuidV7Generator } from '@/infrastructure/system';

export function createUseCases(orm: MikroORM) {
  const runner = new MikroOrmTransactionRunner(orm);
  const clock = new SystemClock();
  const ids = new UuidV7Generator();
  return {
    openWallet: new OpenWallet(runner, clock, ids),
    processWager: new ProcessWagerTransaction(runner, clock, ids),
  };
}

let sequence = 0;

export function wagerCommand(
  walletId: string,
  playerId: string,
  overrides: Partial<ProcessWagerTransactionCommand> = {},
): ProcessWagerTransactionCommand {
  sequence += 1;
  const externalTransactionId = overrides.externalTransactionId ?? `tx-${Date.now()}-${sequence}`;
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    correlationId: `corr-${sequence}`,
    ...overrides,
  };
}

export async function expectBalanceMatchesLedger(orm: MikroORM, walletId: string): Promise<void> {
  const [row] = await orm.em.execute<{ balance: string; rebuilt: string }[]>(
    `SELECT w.balance,
            COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END), 0)::numeric(20, 2) AS rebuilt
       FROM wallets w
       LEFT JOIN wallet_ledger_entries e ON e.wallet_id = w.id
      WHERE w.id = ?
      GROUP BY w.balance`,
    [walletId],
  );
  expect(row).toBeDefined();
  expect(row!.rebuilt).toBe(row!.balance);
}

export async function countRows(
  orm: MikroORM,
  table: string,
  where: string,
  params: unknown[] = [],
): Promise<number> {
  const [row] = await orm.em.execute<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
    params,
  );
  return row!.n;
}
