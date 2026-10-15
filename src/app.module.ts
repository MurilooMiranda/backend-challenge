import type { SQSClient } from '@aws-sdk/client-sqs';
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { PublishOutboxEvents } from './application/messaging/publish-outbox-events';
import {
  CLOCK,
  type Clock,
  EVENT_PUBLISHER,
  type EventPublisher,
  ID_GENERATOR,
  type IdGenerator,
  OUTBOX_STORE,
  type OutboxStore,
  TRANSACTION_RUNNER,
  type TransactionRunner,
  WAGERING_QUERIES,
  type WageringQueries,
} from './application/ports';
import { ProcessWagerTransaction } from './application/wagering/process-wager-transaction';
import { RetryPendingReferences } from './application/wagering/retry-pending-references';
import { OpenWallet } from './application/wallets/open-wallet';
import { SQS_CLIENT, SqsEventPublisher, readSqsQueues } from './infrastructure/messaging/sqs';
import { SqsShutdown, sqsClientProvider } from './infrastructure/messaging/sqs.provider';
import { MikroOrmOutboxStore } from './infrastructure/persistence/mikro-orm-outbox-store';
import { MikroOrmTransactionRunner } from './infrastructure/persistence/mikro-orm-transaction-runner';
import { MikroOrmWageringQueries } from './infrastructure/persistence/mikro-orm-wagering-queries';
import { MIKRO_ORM, OrmShutdown, ormProvider } from './infrastructure/persistence/orm.provider';
import { SystemClock, UuidV7Generator } from './infrastructure/system';
import { AuthGuard } from './interfaces/http/auth.guard';
import { HealthController } from './interfaces/http/health.controller';
import { HttpErrorFilter } from './interfaces/http/http-error.filter';
import { WageringController } from './interfaces/http/wagering.controller';
import { WalletsController } from './interfaces/http/wallets.controller';
import {
  WagerTransactionConsumer,
  defaultConsumerOptions,
} from './interfaces/sqs/wager-transaction-consumer';
import { BackgroundWorkers } from './interfaces/workers/background-workers';

@Module({
  controllers: [HealthController, WalletsController, WageringController],
  providers: [
    ormProvider,
    OrmShutdown,
    sqsClientProvider,
    SqsShutdown,
    AuthGuard,
    BackgroundWorkers,
    { provide: APP_FILTER, useClass: HttpErrorFilter },
    { provide: CLOCK, useValue: new SystemClock() },
    { provide: ID_GENERATOR, useValue: new UuidV7Generator() },
    {
      provide: TRANSACTION_RUNNER,
      useFactory: (orm: MikroORM) => new MikroOrmTransactionRunner(orm),
      inject: [MIKRO_ORM],
    },
    {
      provide: WAGERING_QUERIES,
      useFactory: (orm: MikroORM) => new MikroOrmWageringQueries(orm),
      inject: [MIKRO_ORM],
    },
    {
      provide: OUTBOX_STORE,
      useFactory: (orm: MikroORM) => new MikroOrmOutboxStore(orm),
      inject: [MIKRO_ORM],
    },
    {
      provide: EVENT_PUBLISHER,
      useFactory: (sqs: SQSClient) => new SqsEventPublisher(sqs, readSqsQueues().eventsQueueUrl),
      inject: [SQS_CLIENT],
    },
    {
      provide: OpenWallet,
      useFactory: (runner: TransactionRunner, clock: Clock, ids: IdGenerator) =>
        new OpenWallet(runner, clock, ids),
      inject: [TRANSACTION_RUNNER, CLOCK, ID_GENERATOR],
    },
    {
      provide: ProcessWagerTransaction,
      useFactory: (runner: TransactionRunner, clock: Clock, ids: IdGenerator) =>
        new ProcessWagerTransaction(runner, clock, ids),
      inject: [TRANSACTION_RUNNER, CLOCK, ID_GENERATOR],
    },
    {
      provide: RetryPendingReferences,
      useFactory: (
        runner: TransactionRunner,
        queries: WageringQueries,
        clock: Clock,
        ids: IdGenerator,
      ) => new RetryPendingReferences(runner, queries, clock, ids),
      inject: [TRANSACTION_RUNNER, WAGERING_QUERIES, CLOCK, ID_GENERATOR],
    },
    {
      provide: PublishOutboxEvents,
      useFactory: (outbox: OutboxStore, publisher: EventPublisher, clock: Clock) =>
        new PublishOutboxEvents(outbox, publisher, clock),
      inject: [OUTBOX_STORE, EVENT_PUBLISHER, CLOCK],
    },
    {
      provide: WagerTransactionConsumer,
      useFactory: (sqs: SQSClient, processWager: ProcessWagerTransaction) => {
        const queues = readSqsQueues();
        return new WagerTransactionConsumer(
          sqs,
          processWager,
          defaultConsumerOptions(queues.transactionsQueueUrl, queues.transactionsDlqUrl),
        );
      },
      inject: [SQS_CLIENT, ProcessWagerTransaction],
    },
  ],
})
export class AppModule {}
