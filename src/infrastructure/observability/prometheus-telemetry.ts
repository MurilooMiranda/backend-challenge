import { Logger } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type {
  MessageConsumedEvent,
  ReconciliationCheckedEvent,
  Telemetry,
  TransactionSettledEvent,
} from '@/application/telemetry';

export interface GaugeSources {
  outboxStats: () => Promise<{ pending: number; oldestPendingAgeSeconds: number }>;
  deadLetterDepth: () => Promise<number>;
}

export class PrometheusTelemetry implements Telemetry {
  readonly registry = new Registry();
  private readonly logger = new Logger('Telemetry');

  private readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Wager transactions settled, by channel, kind and resulting status',
    labelNames: ['channel', 'kind', 'status'],
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: 'wager_duplicates_total',
    help: 'Duplicate submissions answered as idempotent replays',
    labelNames: ['channel'],
    registers: [this.registry],
  });
  private readonly latency = new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'End-to-end processing latency of a wager transaction',
    labelNames: ['channel'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.75, 1, 2.5, 5],
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: 'wallet_lock_conflicts_total',
    help: 'Concurrent write conflicts resolved by retrying the transaction',
    labelNames: ['reason'],
    registers: [this.registry],
  });
  private readonly lockWait = new Histogram({
    name: 'wallet_lock_wait_seconds',
    help: 'Time spent waiting for the per-wallet row lock',
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1, 2.5],
    registers: [this.registry],
  });
  private readonly reconciliations = new Counter({
    name: 'wallet_reconciliations_total',
    help: 'Wallet reconciliations by result',
    labelNames: ['result'],
    registers: [this.registry],
  });
  private readonly outbox = new Counter({
    name: 'outbox_messages_total',
    help: 'Outbox publication attempts by result',
    labelNames: ['result'],
    registers: [this.registry],
  });
  private readonly consumed = new Counter({
    name: 'sqs_messages_consumed_total',
    help: 'SQS messages handled by outcome',
    labelNames: ['outcome'],
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: 'sqs_message_retries_total',
    help: 'SQS messages released back to the queue after a transient failure',
    registers: [this.registry],
  });
  private readonly deadLettered = new Counter({
    name: 'sqs_messages_dead_lettered_total',
    help: 'SQS messages sent to the DLQ by this consumer',
    labelNames: ['failure_code'],
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  registerGauges(sources: GaugeSources): void {
    const logger = this.logger;
    let cachedStats: Promise<{ pending: number; oldestPendingAgeSeconds: number }> | undefined;
    const stats = () => {
      cachedStats ??= sources.outboxStats().finally(() => {
        cachedStats = undefined;
      });
      return cachedStats;
    };

    new Gauge({
      name: 'outbox_pending_messages',
      help: 'Outbox messages not yet published',
      registers: [this.registry],
      async collect() {
        try {
          this.set((await stats()).pending);
        } catch (error) {
          logger.warn(`outbox gauge unavailable: ${(error as Error).message}`);
        }
      },
    });
    new Gauge({
      name: 'outbox_lag_seconds',
      help: 'Age of the oldest unpublished outbox message',
      registers: [this.registry],
      async collect() {
        try {
          this.set((await stats()).oldestPendingAgeSeconds);
        } catch (error) {
          logger.warn(`outbox lag gauge unavailable: ${(error as Error).message}`);
        }
      },
    });
    new Gauge({
      name: 'sqs_dead_letter_queue_messages',
      help: 'Approximate number of messages currently in the DLQ',
      registers: [this.registry],
      async collect() {
        try {
          this.set(await sources.deadLetterDepth());
        } catch (error) {
          logger.warn(`dlq gauge unavailable: ${(error as Error).message}`);
        }
      },
    });
  }

  transactionSettled(event: TransactionSettledEvent): void {
    trace.getActiveSpan()?.setAttributes({
      'wager.transaction_id': event.transactionId,
      'wager.kind': event.kind,
      'wager.status': event.status,
      'wager.idempotent_replay': event.idempotentReplay,
      'wallet.id': event.walletId,
      'provider.id': event.providerId,
      ...(event.failureCode ? { 'wager.failure_code': event.failureCode } : {}),
    });
    this.transactions.inc({ channel: event.channel, kind: event.kind, status: event.status });
    this.latency.observe({ channel: event.channel }, event.durationSeconds);
    if (event.idempotentReplay) {
      this.duplicates.inc({ channel: event.channel });
    }
    this.logger.log({
      msg: event.idempotentReplay ? 'wager transaction replayed' : 'wager transaction settled',
      channel: event.channel,
      transactionId: event.transactionId,
      walletId: event.walletId,
      providerId: event.providerId,
      kind: event.kind,
      status: event.status,
      failureCode: event.failureCode,
      idempotentReplay: event.idempotentReplay,
      durationMs: Math.round(event.durationSeconds * 1000),
    });
  }

  lockConflict(reason: string): void {
    this.lockConflicts.inc({ reason });
    this.logger.warn({ msg: 'concurrent write conflict, retrying', reason });
  }

  walletLockWait(seconds: number): void {
    this.lockWait.observe(seconds);
  }

  reconciliationChecked(event: ReconciliationCheckedEvent): void {
    this.reconciliations.inc({ result: event.consistent ? 'consistent' : 'divergent' });
    if (!event.consistent) {
      this.logger.error({
        msg: 'wallet balance diverges from ledger',
        walletId: event.walletId,
        difference: event.difference,
        checkedEntries: event.checkedEntries,
      });
    }
  }

  outboxPublished(published: number, failed: number): void {
    this.outbox.inc({ result: 'published' }, published);
    this.outbox.inc({ result: 'failed' }, failed);
    if (failed > 0) {
      this.logger.warn({ msg: 'outbox publication failed, will retry', published, failed });
    }
  }

  messageConsumed(event: MessageConsumedEvent): void {
    this.consumed.inc({ outcome: event.outcome });
    if (event.outcome === 'retry') {
      this.retries.inc();
    }
    if (event.outcome === 'dead-lettered') {
      this.deadLettered.inc({ failure_code: event.failureCode ?? 'UNKNOWN' });
    }
    const fields = {
      msg: `sqs message ${event.outcome}`,
      messageId: event.messageId,
      ...(event.failureCode ? { failureCode: event.failureCode } : {}),
    };
    if (event.outcome === 'acked') {
      this.logger.log(fields);
    } else {
      this.logger.warn(fields);
    }
  }
}
