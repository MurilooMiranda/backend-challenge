import type { SQSClient } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createSqsClient } from '@/infrastructure/messaging/sqs';
import { createTestOrm, resetDatabase } from '../support/database';
import { type AppInstance, startInstance, stopInstance, waitUntil } from '../support/instances';
import { type TestQueues, createTestQueues, drain, sendRaw, wagerMessage } from '../support/sqs';
import { countRows, expectBalanceMatchesLedger } from '../support/wagering';

setDefaultTimeout(120_000);

const PORTS = [4101, 4102, 4103];

let orm: MikroORM;
let sqs: SQSClient;
let queues: TestQueues;
let instances: AppInstance[] = [];

beforeAll(async () => {
  orm = await createTestOrm();
  await resetDatabase(orm);
  sqs = createSqsClient();
  queues = await createTestQueues(sqs);
  instances = await Promise.all(PORTS.map((port) => startInstance(port, queues)));
});

afterAll(async () => {
  await Promise.all(instances.map(stopInstance));
  await queues.cleanup();
  sqs.destroy();
  await orm.close();
});

const instanceAt = (index: number) => instances[index % instances.length]!;

async function post(
  index: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${instanceAt(index).url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

async function openWallet(amount: string, index = 0) {
  const { status, body } = await post(index, '/wallets', {
    playerId: crypto.randomUUID(),
    initialBalance: { amount, currency: 'BRL' },
  });
  expect(status).toBe(201);
  return body as { id: string; playerId: string };
}

function bet(wallet: { id: string; playerId: string }, amount: string, overrides = {}) {
  const externalTransactionId = `tx-${crypto.randomUUID()}`;
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
    ...overrides,
  };
}

function submit(index: number, payload: ReturnType<typeof bet>) {
  const { idempotencyKey, ...body } = payload;
  return post(index, '/wagering/transactions', body, { 'Idempotency-Key': idempotencyKey });
}

async function balanceOf(walletId: string): Promise<string> {
  const [row] = await orm.em.execute<{ balance: string }[]>(
    'SELECT balance FROM wallets WHERE id = ?',
    [walletId],
  );
  return row!.balance;
}

describe('three application instances sharing Postgres and SQS', () => {
  it('section 8 scenario with each bet hitting a different instance', async () => {
    const wallet = await openWallet('100.00');

    const results = await Promise.all([
      submit(0, bet(wallet, '80.00')),
      submit(1, bet(wallet, '80.00')),
    ]);

    expect(results.map((r) => r.body.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    expect(await balanceOf(wallet.id)).toBe('20.00');
    expect(
      await countRows(orm, 'wallet_ledger_entries', `wallet_id = ? AND direction = 'DEBIT'`, [
        wallet.id,
      ]),
    ).toBe(1);
    await expectBalanceMatchesLedger(orm, wallet.id);
  });

  it('a hot wallet hammered through all instances, every request sent twice, never overdraws', async () => {
    const wallet = await openWallet('100.00');
    const bets = Array.from({ length: 30 }, () => bet(wallet, '5.00'));

    const results = await Promise.all(
      bets.flatMap((payload, i) => [submit(i, payload), submit(i + 1, payload)]),
    );

    expect(results.every((r) => [200, 201, 422].includes(r.status))).toBe(true);
    expect(results.filter((r) => r.body.idempotentReplay === false)).toHaveLength(30);
    expect(
      await countRows(orm, 'wager_transactions', `wallet_id = ? AND kind = 'BET'`, [wallet.id]),
    ).toBe(30);
    expect(
      await countRows(
        orm,
        'wager_transactions',
        `wallet_id = ? AND kind = 'BET' AND status = 'PROCESSED'`,
        [wallet.id],
      ),
    ).toBe(20);
    expect(await balanceOf(wallet.id)).toBe('0.00');
    await expectBalanceMatchesLedger(orm, wallet.id);
  });

  it('three competing SQS consumers apply duplicated messages exactly once', async () => {
    const wallets = await Promise.all(Array.from({ length: 6 }, (_, i) => openWallet('100.00', i)));
    const messages = wallets.flatMap((wallet) =>
      Array.from({ length: 5 }, () => ({ wallet, message: wagerMessage(bet(wallet, '10.00')) })),
    );

    await Promise.all(
      messages.flatMap(({ wallet, message }) => [
        sendRaw(sqs, queues.queueUrl, message.body, wallet.id),
        sendRaw(sqs, queues.queueUrl, message.body, wallet.id),
      ]),
    );

    const messageIds = messages.map(({ message }) => message.messageId);
    await waitUntil(
      async () =>
        (await countRows(orm, 'inbox_messages', 'message_id IN (?)', [messageIds])) ===
        messages.length,
      60_000,
    );

    for (const wallet of wallets) {
      expect(await balanceOf(wallet.id)).toBe('50.00');
      await expectBalanceMatchesLedger(orm, wallet.id);
    }
    expect(await drain(sqs, queues.dlqUrl)).toHaveLength(0);
  });

  it('a REFUND received by one instance before its BET reaches another is resolved by a worker', async () => {
    const wallet = await openWallet('100.00');
    const original = bet(wallet, '30.00');
    const refund = bet(wallet, '30.00', {
      kind: 'REFUND',
      referenceExternalTransactionId: original.externalTransactionId,
    });

    expect((await submit(0, refund)).status).toBe(202);
    expect((await submit(1, original)).status).toBe(201);

    await waitUntil(
      async () =>
        (await countRows(
          orm,
          'wager_transactions',
          `external_transaction_id = ? AND status = 'PROCESSED'`,
          [refund.externalTransactionId],
        )) === 1,
      30_000,
    );
    expect(await balanceOf(wallet.id)).toBe('100.00');
    await expectBalanceMatchesLedger(orm, wallet.id);
  });

  it('an instance killed mid-load is replaced and the system converges with no duplicated effects', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 3 }, (_, i) => openWallet('1000.00', i)),
    );
    const messages = wallets.flatMap((wallet) =>
      Array.from({ length: 20 }, () => ({ wallet, message: wagerMessage(bet(wallet, '1.00')) })),
    );
    await Promise.all(
      messages.map(({ wallet, message }) => sendRaw(sqs, queues.queueUrl, message.body, wallet.id)),
    );

    const victim = instances[1]!;
    await Bun.sleep(300);
    await stopInstance(victim);
    instances[1] = await startInstance(victim.port, queues);

    const messageIds = messages.map(({ message }) => message.messageId);
    await waitUntil(
      async () =>
        (await countRows(orm, 'inbox_messages', 'message_id IN (?)', [messageIds])) ===
        messages.length,
      90_000,
    );

    for (const wallet of wallets) {
      expect(await balanceOf(wallet.id)).toBe('980.00');
      await expectBalanceMatchesLedger(orm, wallet.id);
      const reconciliation = await post(0, `/wallets/${wallet.id}/reconciliation`, {});
      expect(reconciliation.body.consistent).toBe(true);
    }
  });

  it('three outbox publishers drain every committed event', async () => {
    await waitUntil(
      async () => (await countRows(orm, 'outbox_messages', 'published_at IS NULL')) === 0,
      60_000,
    );
    const total = await countRows(orm, 'outbox_messages', 'true');
    const published = await drain(sqs, queues.eventsUrl, 100);
    const eventIds = published.map((m) => JSON.parse(m.Body!).eventId);
    expect(new Set(eventIds).size).toBe(eventIds.length);
    expect(eventIds.length).toBe(total);
  });
});
