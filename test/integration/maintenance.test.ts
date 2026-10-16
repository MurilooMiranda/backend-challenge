import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { PurgeExpiredMessages } from '@/application/maintenance/purge-expired-messages';
import { ReconcileAllWallets } from '@/application/maintenance/reconcile-all-wallets';
import {
  type ReconciliationCheckedEvent,
  type ReconciliationScanEvent,
  type Telemetry,
  noopTelemetry,
} from '@/application/telemetry';
import { MikroOrmMaintenanceStore } from '@/infrastructure/persistence/mikro-orm-maintenance-store';
import { SystemClock } from '@/infrastructure/system';
import { createTestOrm, resetDatabase } from '../support/database';
import { countRows, createUseCases, wagerCommand } from '../support/wagering';

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

const HOUR = 60 * 60 * 1_000;

async function walletWithBet(amount = '100.00') {
  const wallet = await useCases.openWallet.execute({
    playerId: crypto.randomUUID(),
    initialBalance: { amount, currency: 'BRL' },
    correlationId: 'maintenance',
  });
  await useCases.processWager.execute(
    wagerCommand(wallet.id, wallet.playerId, { money: { amount: '10.00', currency: 'BRL' } }),
  );
  return wallet;
}

function recordingTelemetry() {
  const checked: ReconciliationCheckedEvent[] = [];
  const scans: ReconciliationScanEvent[] = [];
  const purged: { table: string; count: number }[] = [];
  const telemetry: Telemetry = {
    ...noopTelemetry,
    reconciliationChecked: (event) => checked.push(event),
    reconciliationScanCompleted: (event) => scans.push(event),
    messagesPurged: (table, count) => purged.push({ table, count }),
  };
  return { telemetry, checked, scans, purged };
}

describe('retention of inbox and outbox', () => {
  it('deletes only published outbox events and processed inbox messages past their retention', async () => {
    const wallet = await walletWithBet();
    const outboxIds = (
      await orm.em.execute<{ id: string }[]>('SELECT id FROM outbox_messages ORDER BY sequence')
    ).map((row) => row.id);
    expect(outboxIds).toHaveLength(3);
    const [old, recent, pending] = outboxIds as [string, string, string];
    await orm.em.execute(
      `UPDATE outbox_messages SET published_at = now() - interval '4 days' WHERE id = ?`,
      [old],
    );
    await orm.em.execute(
      `UPDATE outbox_messages SET published_at = now() - interval '1 hour' WHERE id = ?`,
      [recent],
    );

    await orm.em.execute(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at) VALUES
         ('c', 'old',        'h', now() - interval '10 days', now() - interval '10 days'),
         ('c', 'recent',     'h', now() - interval '1 day',   now() - interval '1 day'),
         ('c', 'unfinished', 'h', now() - interval '30 days', NULL)`,
    );

    const { telemetry, purged } = recordingTelemetry();
    const purge = new PurgeExpiredMessages(
      new MikroOrmMaintenanceStore(orm),
      new SystemClock(),
      { outboxRetentionMs: 72 * HOUR, inboxRetentionMs: 7 * 24 * HOUR, batchSize: 100 },
      telemetry,
    );

    expect(await purge.execute()).toEqual({ outbox: 1, inbox: 1 });
    expect(purged).toEqual([
      { table: 'outbox', count: 1 },
      { table: 'inbox', count: 1 },
    ]);
    const remainingOutbox = (
      await orm.em.execute<{ id: string }[]>('SELECT id FROM outbox_messages')
    ).map((row) => row.id);
    expect(remainingOutbox.sort()).toEqual([recent, pending].sort());
    const remainingInbox = (
      await orm.em.execute<{ message_id: string }[]>('SELECT message_id FROM inbox_messages')
    ).map((row) => row.message_id);
    expect(remainingInbox.sort()).toEqual(['recent', 'unfinished']);
    expect(await countRows(orm, 'wallet_ledger_entries', 'wallet_id = ?', [wallet.id])).toBe(2);
  });

  it('works in bounded batches and reports when more work remains', async () => {
    for (let i = 0; i < 5; i++) {
      await walletWithBet();
    }
    await orm.em.execute(`UPDATE outbox_messages SET published_at = now() - interval '5 days'`);
    const total = await countRows(orm, 'outbox_messages', 'true');

    const purge = new PurgeExpiredMessages(new MikroOrmMaintenanceStore(orm), new SystemClock(), {
      outboxRetentionMs: 72 * HOUR,
      inboxRetentionMs: 7 * 24 * HOUR,
      batchSize: 4,
    });
    let rounds = 0;
    let deleted = 0;
    for (;;) {
      const result = await purge.execute();
      rounds += 1;
      deleted += result.outbox;
      expect(result.outbox).toBeLessThanOrEqual(4);
      if (!purge.hasMoreWork(result)) break;
    }
    expect(deleted).toBe(total);
    expect(rounds).toBe(Math.ceil(total / 4) + (total % 4 === 0 ? 1 : 0));
    expect(await countRows(orm, 'outbox_messages', 'true')).toBe(0);
  });
});

describe('periodic reconciliation of every wallet', () => {
  it('a clean database reports every wallet as consistent, scanning in batches', async () => {
    for (let i = 0; i < 7; i++) {
      await walletWithBet();
    }
    const { telemetry, scans, checked } = recordingTelemetry();
    const result = await new ReconcileAllWallets(
      new MikroOrmMaintenanceStore(orm),
      telemetry,
      3,
    ).execute();

    expect(result.skipped).toBe(false);
    expect(result.checked).toBe(7);
    expect(result.divergent).toEqual([]);
    expect(checked).toEqual([]);
    expect(scans).toEqual([{ checked: 7, divergent: 0, durationSeconds: expect.any(Number) }]);
  });

  it('flags a wallet whose stored balance drifted from both ledgers, without fixing it', async () => {
    const healthy = await walletWithBet();
    const corrupted = await walletWithBet();
    await orm.em.fork().transactional(async (em) => {
      await em.execute('SET LOCAL session_replication_role = replica');
      await em.execute('UPDATE wallets SET balance = 500.00 WHERE id = ?', [corrupted.id]);
    });

    const { telemetry, checked, scans } = recordingTelemetry();
    const result = await new ReconcileAllWallets(
      new MikroOrmMaintenanceStore(orm),
      telemetry,
    ).execute();

    expect(result.checked).toBe(2);
    expect(result.divergent.map((d) => d.walletId)).toEqual([corrupted.id]);
    const [divergence] = result.divergent;
    expect(divergence!.stored.toJSON().amount).toBe('500.00');
    expect(divergence!.ledger.toJSON().amount).toBe('90.00');
    expect(divergence!.journal.toJSON().amount).toBe('90.00');
    expect(checked).toEqual([
      { walletId: corrupted.id, consistent: false, difference: '410.00', checkedEntries: 0 },
    ]);
    expect(scans[0]!.divergent).toBe(1);

    const [row] = await orm.em.execute<{ balance: string }[]>(
      'SELECT balance FROM wallets WHERE id = ?',
      [corrupted.id],
    );
    expect(row!.balance).toBe('500.00');
    expect(result.divergent.some((d) => d.walletId === healthy.id)).toBe(false);
  });

  it('only one instance scans at a time: a concurrent scan is skipped', async () => {
    await walletWithBet();
    let release!: () => void;
    const holding = orm.em.fork().transactional(async (em) => {
      await em.execute('SELECT pg_advisory_xact_lock(7316001)');
      await new Promise<void>((resolve) => (release = resolve));
    });
    await Bun.sleep(100);

    const { telemetry, scans } = recordingTelemetry();
    const result = await new ReconcileAllWallets(
      new MikroOrmMaintenanceStore(orm),
      telemetry,
    ).execute();
    release();
    await holding;

    expect(result).toEqual({ skipped: true, checked: 0, divergent: [] });
    expect(scans).toEqual([]);

    const afterRelease = await new ReconcileAllWallets(new MikroOrmMaintenanceStore(orm)).execute();
    expect(afterRelease.skipped).toBe(false);
  });
});
