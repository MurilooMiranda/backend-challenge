import 'reflect-metadata';
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { PublishOutboxEvents } from '@/application/messaging/publish-outbox-events';
import { AppModule } from '@/app.module';
import { SqsEventPublisher, createSqsClient } from '@/infrastructure/messaging/sqs';
import { JsonLogger } from '@/infrastructure/observability/json-logger';
import {
  SpanKind,
  setupTracing,
  shutdownTracing,
  withSpan,
} from '@/infrastructure/observability/tracing';
import { MikroOrmOutboxStore } from '@/infrastructure/persistence/mikro-orm-outbox-store';
import { SystemClock } from '@/infrastructure/system';
import { WagerTransactionConsumer } from '@/interfaces/sqs/wager-transaction-consumer';
import { TEST_DATABASE_URL, createTestOrm, resetDatabase } from '../support/database';
import { type TestQueues, createTestQueues, drain, wagerMessage } from '../support/sqs';
import { createUseCases, wagerCommand } from '../support/wagering';

const exporter = new InMemorySpanExporter();
let orm: MikroORM;
let app: INestApplication;
let baseUrl: string;
let sqs: SQSClient;
let queues: TestQueues;
const previousEnv = { ...process.env };

beforeAll(async () => {
  setupTracing({ serviceName: 'wagering-test', exporter });
  orm = await createTestOrm();
  sqs = createSqsClient();
  Object.assign(process.env, { DATABASE_URL: TEST_DATABASE_URL, WORKERS_ENABLED: 'false' });
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');
});

beforeEach(async () => {
  await resetDatabase(orm);
  exporter.reset();
  queues = await createTestQueues(sqs);
});

afterAll(async () => {
  await queues.cleanup();
  await app.close();
  await orm.close();
  sqs.destroy();
  await shutdownTracing();
  Object.assign(process.env, previousEnv);
});

const randomHex = (bytes: number) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

function incomingTrace() {
  const traceId = randomHex(16);
  const spanId = randomHex(8);
  return { traceId, spanId, traceparent: `00-${traceId}-${spanId}-01` };
}

const parentOf = (span: ReadableSpan) => span.parentSpanContext?.spanId;

async function spansOf(traceId: string, expected: (spans: ReadableSpan[]) => boolean) {
  for (let i = 0; i < 50; i++) {
    const spans = exporter.getFinishedSpans().filter((s) => s.spanContext().traceId === traceId);
    if (expected(spans)) {
      return spans;
    }
    await Bun.sleep(20);
  }
  throw new Error('expected spans not exported');
}

async function post(path: string, body: unknown, headers: Record<string, string>) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as any,
  };
}

async function openWallet() {
  const { body } = await post(
    '/wallets',
    { playerId: crypto.randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } },
    {},
  );
  return body as { id: string; playerId: string };
}

async function betWithTrace(traceparent: string) {
  const wallet = await openWallet();
  const command = wagerCommand(wallet.id, wallet.playerId);
  const { idempotencyKey, correlationId: _c, ...body } = command;
  return post('/wagering/transactions', body, {
    'Idempotency-Key': idempotencyKey,
    traceparent,
  });
}

describe('distributed tracing', () => {
  it('an HTTP request continues the caller trace and nests the transaction and the wallet lock', async () => {
    const caller = incomingTrace();
    const response = await betWithTrace(caller.traceparent);
    expect(response.status).toBe(201);
    expect(response.headers.get('x-trace-id')).toBe(caller.traceId);

    const spans = await spansOf(caller.traceId, (all) =>
      all.some((s) => s.kind === SpanKind.SERVER),
    );
    const http = spans.find((s) => s.kind === SpanKind.SERVER)!;
    const transaction = spans.find((s) => s.name === 'db.transaction')!;
    const lock = spans.find((s) => s.name === 'wallet.lock')!;

    expect(http.name).toBe('POST /wagering/transactions');
    expect(parentOf(http)).toBe(caller.spanId);
    expect(http.attributes['http.response.status_code']).toBe(201);
    expect(http.attributes['wager.status']).toBe('PROCESSED');
    expect(parentOf(transaction)).toBe(http.spanContext().spanId);
    expect(parentOf(lock)).toBe(transaction.spanContext().spanId);
    expect(lock.attributes['wallet.id']).toEqual(expect.any(String));
  });

  it('the outbox carries the request trace to the published events', async () => {
    const caller = incomingTrace();
    await betWithTrace(caller.traceparent);

    const rows = await orm.em.execute<{ event_type: string; headers: Record<string, string> }[]>(
      `SELECT event_type, headers FROM outbox_messages WHERE headers->>'traceparent' LIKE ?`,
      [`00-${caller.traceId}-%`],
    );
    expect(rows.map((row) => row.event_type).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);

    const publish = new PublishOutboxEvents(
      new MikroOrmOutboxStore(orm),
      new SqsEventPublisher(sqs, queues.eventsUrl),
      new SystemClock(),
    );
    while ((await publish.execute()).published > 0) {}

    const delivered = (await drain(sqs, queues.eventsUrl)).filter((message) =>
      message.MessageAttributes?.traceparent?.StringValue?.includes(caller.traceId),
    );
    expect(delivered).toHaveLength(2);

    const producers = await spansOf(
      caller.traceId,
      (all) => all.filter((s) => s.kind === SpanKind.PRODUCER).length === 2,
    );
    expect(
      producers
        .filter((s) => s.kind === SpanKind.PRODUCER)
        .map((s) => s.name)
        .sort(),
    ).toEqual(['publish WagerTransactionProcessed', 'publish WalletBalanceChanged']);
  });

  it('a consumed SQS message continues the trace of its producer', async () => {
    const wallet = await openWallet();
    const producer = incomingTrace();
    const { correlationId: _c, ...data } = wagerCommand(wallet.id, wallet.playerId);
    const message = wagerMessage(data);
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queues.queueUrl,
        MessageBody: message.body,
        MessageGroupId: wallet.id,
        MessageDeduplicationId: message.messageId,
        MessageAttributes: {
          traceparent: { DataType: 'String', StringValue: producer.traceparent },
        },
      }),
    );

    const consumer = new WagerTransactionConsumer(sqs, createUseCases(orm).processWager, {
      queueUrl: queues.queueUrl,
      deadLetterQueueUrl: queues.dlqUrl,
      consumerName: 'wager-transactions-consumer',
      maxMessages: 10,
      waitTimeSeconds: 1,
      retryBaseSeconds: 0,
      maxRetrySeconds: 0,
    });
    expect(await consumer.pollOnce()).toEqual(['acked']);

    const spans = await spansOf(producer.traceId, (all) =>
      all.some((s) => s.kind === SpanKind.CONSUMER),
    );
    const consume = spans.find((s) => s.kind === SpanKind.CONSUMER)!;
    expect(consume.name).toBe('process wager-transactions');
    expect(parentOf(consume)).toBe(producer.spanId);
    expect(consume.attributes['messaging.outcome']).toBe('acked');
    const transaction = spans.find((s) => s.name === 'db.transaction')!;
    expect(parentOf(transaction)).toBe(consume.spanContext().spanId);
  });

  it('log lines written inside a span carry its trace and span ids', async () => {
    const lines: string[] = [];
    const spy = spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    let ids: { traceId: string; spanId: string } | undefined;
    try {
      await withSpan('unit-of-work', {}, async (span) => {
        ids = { traceId: span.spanContext().traceId, spanId: span.spanContext().spanId };
        new JsonLogger().log({ msg: 'inside span' });
      });
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(lines[0]!)).toMatchObject({ msg: 'inside span', ...ids });
  });
});
