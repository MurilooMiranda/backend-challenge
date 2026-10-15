import type { SQSClient } from '@aws-sdk/client-sqs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { InfrastructureUnavailableError } from '@/application/errors';
import { PublishOutboxEvents } from '@/application/messaging/publish-outbox-events';
import type { Clock, EventPublisher } from '@/application/ports';
import type { ProcessWagerTransaction } from '@/application/wagering/process-wager-transaction';
import { RetryPendingReferences } from '@/application/wagering/retry-pending-references';
import type { OutboxMessage } from '@/domain/messaging/outbox-message';
import { FailureCode } from '@/domain/wagering/failure-code';
import { ReferenceRetryPolicy } from '@/domain/wagering/reference-retry-policy';
import { WagerTransactionStatus as Status } from '@/domain/wagering/wager-transaction';
import { SqsEventPublisher, createSqsClient } from '@/infrastructure/messaging/sqs';
import { MikroOrmOutboxStore } from '@/infrastructure/persistence/mikro-orm-outbox-store';
import { MikroOrmTransactionRunner } from '@/infrastructure/persistence/mikro-orm-transaction-runner';
import { MikroOrmWageringQueries } from '@/infrastructure/persistence/mikro-orm-wagering-queries';
import { SystemClock, UuidV7Generator } from '@/infrastructure/system';
import { WagerTransactionConsumer } from '@/interfaces/sqs/wager-transaction-consumer';
import { createTestOrm, resetDatabase } from '../support/database';
import { type TestQueues, createTestQueues, drain, sendRaw, wagerMessage } from '../support/sqs';
import {
  countRows,
  createUseCases,
  expectBalanceMatchesLedger,
  wagerCommand,
} from '../support/wagering';

class FakeClock implements Clock {
  constructor(private current = new Date()) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

class RecordingPublisher implements EventPublisher {
  readonly published: string[] = [];
  constructor(private readonly delayMs = 0) {}
  async publish(message: OutboxMessage): Promise<void> {
    if (this.delayMs > 0) {
      await Bun.sleep(this.delayMs);
    }
    this.published.push(message.id);
  }
}

let orm: MikroORM;
let sqs: SQSClient;
let queues: TestQueues;
let useCases: ReturnType<typeof createUseCases>;

beforeAll(async () => {
  orm = await createTestOrm();
  sqs = createSqsClient();
  useCases = createUseCases(orm);
});

beforeEach(async () => {
  await resetDatabase(orm);
  queues = await createTestQueues(sqs);
});

afterEach(async () => {
  await queues.cleanup();
});

afterAll(async () => {
  sqs.destroy();
  await orm.close();
});

async function openWallet(amount = '100.00') {
  return useCases.openWallet.execute({
    playerId: crypto.randomUUID(),
    initialBalance: { amount, currency: 'BRL' },
    correlationId: 'test',
  });
}

function consumerWith(processWager: ProcessWagerTransaction = useCases.processWager) {
  return new WagerTransactionConsumer(sqs, processWager, {
    queueUrl: queues.queueUrl,
    deadLetterQueueUrl: queues.dlqUrl,
    consumerName: 'wager-transactions-consumer',
    maxMessages: 10,
    waitTimeSeconds: 1,
    retryBaseSeconds: 0,
    maxRetrySeconds: 0,
  });
}

async function publishAll(instance: PublishOutboxEvents, batchSize = 25): Promise<number> {
  let total = 0;
  for (;;) {
    const { published } = await instance.execute(batchSize);
    if (published === 0) {
      return total;
    }
    total += published;
  }
}

async function pendingIdsInOrder(): Promise<string[]> {
  const rows = await orm.em.execute<{ id: string }[]>(
    `SELECT id FROM outbox_messages WHERE published_at IS NULL ORDER BY sequence`,
  );
  return rows.map((row) => row.id);
}

function messageData(wallet: { id: string; playerId: string }, overrides = {}) {
  const command = wagerCommand(wallet.id, wallet.playerId, overrides);
  const { correlationId: _correlationId, ...data } = command;
  return data;
}

describe('transactional outbox', () => {
  it('publishes committed events to SQS, grouped by wallet, and marks them as published', async () => {
    const wallet = await openWallet('100.00');
    await useCases.processWager.execute(wagerCommand(wallet.id, wallet.playerId));
    expect(await countRows(orm, 'outbox_messages', 'published_at IS NULL')).toBe(3);

    const publish = new PublishOutboxEvents(
      new MikroOrmOutboxStore(orm),
      new SqsEventPublisher(sqs, queues.eventsUrl),
      new SystemClock(),
    );
    expect(await publishAll(publish)).toBe(3);
    expect(await countRows(orm, 'outbox_messages', 'published_at IS NULL')).toBe(0);

    const received = await drain(sqs, queues.eventsUrl);
    const bodies = received.map((m) => JSON.parse(m.Body!));
    expect(bodies.map((b) => b.eventType).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WalletBalanceChanged',
    ]);
    expect(received.every((m) => m.Attributes?.MessageGroupId === wallet.id)).toBe(true);
    expect(bodies.every((b) => b.version === 1 && typeof b.eventId === 'string')).toBe(true);
  });

  it('an instance that dies mid-publish leaves events pending and another instance publishes them', async () => {
    const wallet = await openWallet('100.00');
    await useCases.processWager.execute(wagerCommand(wallet.id, wallet.playerId));

    const store = new MikroOrmOutboxStore(orm);
    await expect(
      store.processDueBatch(25, new Date(), async () => {
        throw new Error('process killed');
      }),
    ).rejects.toThrow('process killed');
    expect(await countRows(orm, 'outbox_messages', 'published_at IS NULL')).toBe(3);

    const recorder = new RecordingPublisher();
    const survivor = new PublishOutboxEvents(
      new MikroOrmOutboxStore(orm),
      recorder,
      new SystemClock(),
    );
    expect(await publishAll(survivor)).toBe(3);
    expect(await countRows(orm, 'outbox_messages', 'published_at IS NULL')).toBe(0);
  });

  it('two concurrent publishers on the same outbox never publish an event twice', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => openWallet('100.00')));
    await Promise.all(
      wallets.map((w) => useCases.processWager.execute(wagerCommand(w.id, w.playerId))),
    );
    const total = await countRows(orm, 'outbox_messages', 'published_at IS NULL');
    expect(total).toBe(60);

    const recorder = new RecordingPublisher(2);
    const publisher = () =>
      new PublishOutboxEvents(new MikroOrmOutboxStore(orm), recorder, new SystemClock());
    await Promise.all([publishAll(publisher(), 5), publishAll(publisher(), 5)]);

    expect(recorder.published).toHaveLength(total);
    expect(new Set(recorder.published).size).toBe(total);
    expect(await countRows(orm, 'outbox_messages', 'published_at IS NULL')).toBe(0);
  });

  it('a failed publication is retried later with backoff, keeping per-wallet order', async () => {
    const wallet = await openWallet('100.00');
    await useCases.processWager.execute(wagerCommand(wallet.id, wallet.playerId));
    const expectedOrder = await pendingIdsInOrder();

    const clock = new FakeClock();
    const failing: EventPublisher = {
      publish: async () => {
        throw new Error('SQS down');
      },
    };
    const result = await new PublishOutboxEvents(
      new MikroOrmOutboxStore(orm),
      failing,
      clock,
    ).execute();
    expect(result).toEqual({ published: 0, failed: 1 });

    const [row] = await orm.em.execute<
      { attempts: number; last_error: string; next_attempt_at: Date }[]
    >(`SELECT attempts, last_error, next_attempt_at FROM outbox_messages WHERE attempts > 0`);
    expect(row!.attempts).toBe(1);
    expect(row!.last_error).toBe('SQS down');
    expect(new Date(row!.next_attempt_at).getTime()).toBeGreaterThan(clock.now().getTime());

    const recorder = new RecordingPublisher();
    const retry = new PublishOutboxEvents(new MikroOrmOutboxStore(orm), recorder, clock);
    expect((await retry.execute()).published).toBe(0);

    clock.advance(5_000);
    expect(await publishAll(retry)).toBe(3);
    expect(recorder.published).toEqual(expectedOrder);
  });
});

describe('SQS consumer', () => {
  it('applies the message through the same use case, records the inbox and acks after commit', async () => {
    const wallet = await openWallet('100.00');
    const message = wagerMessage(messageData(wallet));
    await sendRaw(sqs, queues.queueUrl, message.body, wallet.id);

    const outcomes = await consumerWith().pollOnce();

    expect(outcomes).toEqual(['acked']);
    expect(await countRows(orm, 'inbox_messages', 'message_id = ?', [message.messageId])).toBe(1);
    expect(
      await countRows(orm, 'wallet_ledger_entries', `wallet_id = ? AND direction = 'DEBIT'`, [
        wallet.id,
      ]),
    ).toBe(1);
    expect(await drain(sqs, queues.queueUrl)).toHaveLength(0);
    await expectBalanceMatchesLedger(orm, wallet.id);
  });

  it('a redelivered message does not duplicate effects', async () => {
    const wallet = await openWallet('100.00');
    const message = wagerMessage(messageData(wallet));
    await sendRaw(sqs, queues.queueUrl, message.body, wallet.id);
    await sendRaw(sqs, queues.queueUrl, message.body, wallet.id);

    const consumer = consumerWith();
    const outcomes = [...(await consumer.pollOnce()), ...(await consumer.pollOnce())];

    expect(outcomes).toEqual(['acked', 'acked']);
    expect(
      await countRows(orm, 'wallet_ledger_entries', `wallet_id = ? AND direction = 'DEBIT'`, [
        wallet.id,
      ]),
    ).toBe(1);
    expect(await countRows(orm, 'inbox_messages', 'message_id = ?', [message.messageId])).toBe(1);
    await expectBalanceMatchesLedger(orm, wallet.id);
  });

  it('a worker killed after commit and before ack is recovered on redelivery without double debit', async () => {
    const wallet = await openWallet('100.00');
    const data = messageData(wallet);
    const message = wagerMessage(data);
    await sendRaw(sqs, queues.queueUrl, message.body, wallet.id);

    await useCases.processWager.execute({
      ...data,
      correlationId: message.messageId,
      inbox: { consumerName: 'wager-transactions-consumer', messageId: message.messageId },
    });

    const outcomes = await consumerWith().pollOnce();

    expect(outcomes).toEqual(['acked']);
    expect(
      await countRows(orm, 'wallet_ledger_entries', `wallet_id = ? AND direction = 'DEBIT'`, [
        wallet.id,
      ]),
    ).toBe(1);
    expect(await drain(sqs, queues.queueUrl)).toHaveLength(0);
  });

  it('malformed and invalid messages are permanent failures and go straight to the DLQ', async () => {
    const wallet = await openWallet('100.00');
    await sendRaw(sqs, queues.queueUrl, 'not json', 'g1');
    await sendRaw(
      sqs,
      queues.queueUrl,
      wagerMessage(messageData(wallet, { kind: 'OPENING' })).body,
      'g2',
    );
    await sendRaw(
      sqs,
      queues.queueUrl,
      wagerMessage(messageData({ id: crypto.randomUUID(), playerId: 'p' })).body,
      'g3',
    );

    const outcomes = await consumerWith().pollOnce();

    expect(outcomes).toEqual(['dead-lettered', 'dead-lettered', 'dead-lettered']);
    const dead = await drain(sqs, queues.dlqUrl);
    expect(dead.map((m) => m.MessageAttributes?.failureCode?.StringValue).sort()).toEqual([
      'INVALID_MESSAGE',
      'INVALID_MESSAGE',
      'WALLET_NOT_FOUND',
    ]);
    expect(await drain(sqs, queues.queueUrl)).toHaveLength(0);
  });

  it('a business rejection is acked, not retried', async () => {
    const wallet = await openWallet('10.00');
    await sendRaw(
      sqs,
      queues.queueUrl,
      wagerMessage(messageData(wallet, { money: { amount: '80.00', currency: 'BRL' } })).body,
      wallet.id,
    );

    expect(await consumerWith().pollOnce()).toEqual(['acked']);
    expect(await countRows(orm, 'wager_transactions', `status = 'REJECTED'`)).toBe(1);
  });

  it('a transient failure is retried and succeeds on redelivery', async () => {
    const wallet = await openWallet('100.00');
    await sendRaw(sqs, queues.queueUrl, wagerMessage(messageData(wallet)).body, wallet.id);

    let calls = 0;
    const flaky = {
      execute: async (command: Parameters<ProcessWagerTransaction['execute']>[0]) => {
        calls += 1;
        if (calls === 1) {
          throw new InfrastructureUnavailableError('database restarting');
        }
        return useCases.processWager.execute(command);
      },
    } as ProcessWagerTransaction;
    const consumer = consumerWith(flaky);

    expect(await consumer.pollOnce()).toEqual(['retry']);
    expect(await consumer.pollOnce()).toEqual(['acked']);
    expect(
      await countRows(orm, 'wallet_ledger_entries', `wallet_id = ? AND direction = 'DEBIT'`, [
        wallet.id,
      ]),
    ).toBe(1);
  });

  it('a message that keeps failing transiently ends up in the DLQ after maxReceiveCount', async () => {
    const wallet = await openWallet('100.00');
    await sendRaw(sqs, queues.queueUrl, wagerMessage(messageData(wallet)).body, wallet.id);

    const alwaysDown = {
      execute: async () => {
        throw new InfrastructureUnavailableError('database down');
      },
    } as unknown as ProcessWagerTransaction;
    const consumer = consumerWith(alwaysDown);

    const outcomes: string[] = [];
    for (let i = 0; i < 8; i++) {
      outcomes.push(...(await consumer.pollOnce()));
    }

    expect(outcomes.filter((o) => o === 'retry')).toHaveLength(5);
    expect(await drain(sqs, queues.dlqUrl)).toHaveLength(1);
    expect(
      await countRows(orm, 'wager_transactions', `wallet_id = ? AND kind = 'BET'`, [wallet.id]),
    ).toBe(0);
  });

  it('stop() (SIGTERM) waits for the in-flight message to finish and ack', async () => {
    const wallet = await openWallet('100.00');
    await sendRaw(sqs, queues.queueUrl, wagerMessage(messageData(wallet)).body, wallet.id);

    let started!: () => void;
    const processingStarted = new Promise<void>((resolve) => (started = resolve));
    const slow = {
      execute: async (command: Parameters<ProcessWagerTransaction['execute']>[0]) => {
        started();
        await Bun.sleep(300);
        return useCases.processWager.execute(command);
      },
    } as ProcessWagerTransaction;
    const consumer = consumerWith(slow);

    consumer.start();
    await processingStarted;
    await consumer.stop();

    expect(
      await countRows(orm, 'wallet_ledger_entries', `wallet_id = ? AND direction = 'DEBIT'`, [
        wallet.id,
      ]),
    ).toBe(1);
    expect(await drain(sqs, queues.queueUrl)).toHaveLength(0);
  });
});

describe('pending reference worker', () => {
  function retryWorker(clock: Clock, policy = ReferenceRetryPolicy.default()) {
    return new RetryPendingReferences(
      new MikroOrmTransactionRunner(orm),
      new MikroOrmWageringQueries(orm),
      clock,
      new UuidV7Generator(),
      policy,
    );
  }

  it('a ROLLBACK delivered before its BET is applied once the BET arrives', async () => {
    const wallet = await openWallet('100.00');
    const bet = wagerCommand(wallet.id, wallet.playerId);
    const rollback = await useCases.processWager.execute(
      wagerCommand(wallet.id, wallet.playerId, {
        kind: 'ROLLBACK',
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    expect(rollback.status).toBe(Status.PendingReference);

    await useCases.processWager.execute(bet);

    const clock = new FakeClock();
    clock.advance(60_000);
    expect(await retryWorker(clock).execute()).toEqual({ checked: 1, resolved: 1 });

    const [row] = await orm.em.execute<{ status: string; balance: string }[]>(
      `SELECT t.status, w.balance FROM wager_transactions t JOIN wallets w ON w.id = t.wallet_id WHERE t.id = ?`,
      [rollback.transactionId],
    );
    expect(row).toEqual({ status: 'PROCESSED', balance: '100.00' });
    expect(
      await countRows(
        orm,
        'outbox_messages',
        `event_type = 'WagerTransactionProcessed' AND payload->'data'->>'kind' = 'ROLLBACK'`,
      ),
    ).toBe(1);
    await expectBalanceMatchesLedger(orm, wallet.id);
  });

  it('is not picked up before its next check time', async () => {
    const wallet = await openWallet('100.00');
    await useCases.processWager.execute(
      wagerCommand(wallet.id, wallet.playerId, {
        kind: 'REFUND',
        referenceExternalTransactionId: 'ghost',
      }),
    );
    expect(await retryWorker(new FakeClock()).execute()).toEqual({ checked: 0, resolved: 0 });
  });

  it('gives up with REFERENCE_NOT_FOUND after the retry budget and emits a rejection event', async () => {
    const wallet = await openWallet('100.00');
    const refund = await useCases.processWager.execute(
      wagerCommand(wallet.id, wallet.playerId, {
        kind: 'REFUND',
        referenceExternalTransactionId: 'never-arrives',
      }),
    );

    const clock = new FakeClock();
    const worker = retryWorker(clock, ReferenceRetryPolicy.default());
    for (let i = 0; i < 12; i++) {
      clock.advance(10 * 60_000);
      await worker.execute();
    }

    const [row] = await orm.em.execute<
      { status: string; failure_code: string; reference_attempts: number }[]
    >(`SELECT status, failure_code, reference_attempts FROM wager_transactions WHERE id = ?`, [
      refund.transactionId,
    ]);
    expect(row!.status).toBe('REJECTED');
    expect(row!.failure_code).toBe(FailureCode.ReferenceNotFound);
    expect(row!.reference_attempts).toBe(10);
    expect(
      await countRows(orm, 'outbox_messages', `event_type = 'WagerTransactionPendingReference'`),
    ).toBe(1);
    expect(await countRows(orm, 'outbox_messages', `event_type = 'WagerTransactionRejected'`)).toBe(
      1,
    );
  });

  it('concurrent workers apply a resolved reference exactly once', async () => {
    const wallet = await openWallet('100.00');
    const bet = wagerCommand(wallet.id, wallet.playerId);
    await useCases.processWager.execute(
      wagerCommand(wallet.id, wallet.playerId, {
        kind: 'REFUND',
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    await useCases.processWager.execute(bet);

    const clock = new FakeClock();
    clock.advance(60_000);
    const results = await Promise.all([
      retryWorker(clock).execute(),
      retryWorker(clock).execute(),
      retryWorker(clock).execute(),
    ]);

    expect(results.reduce((sum, r) => sum + r.resolved, 0)).toBe(1);
    expect(
      await countRows(orm, 'wallet_ledger_entries', `wallet_id = ? AND direction = 'CREDIT'`, [
        wallet.id,
      ]),
    ).toBe(2);
    await expectBalanceMatchesLedger(orm, wallet.id);
  });
});
