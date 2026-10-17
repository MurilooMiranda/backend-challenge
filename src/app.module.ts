import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { GetTrialBalance } from './application/ledger/get-trial-balance';
import {
  PurgeExpiredMessages,
  retentionPolicyFromEnv,
} from './application/maintenance/purge-expired-messages';
import { ReconcileAllWallets } from './application/maintenance/reconcile-all-wallets';
import { ANONYMOUS_PRINCIPAL, TOKEN_VERIFIER, type TokenVerifier } from './application/auth';
import { PublishOutboxEvents } from './application/messaging/publish-outbox-events';
import {
  CLOCK,
  type Clock,
  EVENT_PUBLISHER,
  type EventPublisher,
  ID_GENERATOR,
  type IdGenerator,
  MAINTENANCE_STORE,
  type MaintenanceStore,
  OUTBOX_STORE,
  TRANSACTION_RUNNER,
  type TransactionRunner,
  WAGERING_QUERIES,
  type WageringQueries,
} from './application/ports';
import { TELEMETRY, type Telemetry } from './application/telemetry';
import { ProcessWagerTransaction } from './application/wagering/process-wager-transaction';
import { RetryPendingReferences } from './application/wagering/retry-pending-references';
import { GetWalletLedger } from './application/wallets/get-wallet-ledger';
import { OpenWallet } from './application/wallets/open-wallet';
import { ReconcileWallet } from './application/wallets/reconcile-wallet';
import { ReferenceRetryPolicy } from './domain/wagering/reference-retry-policy';
import { SQS_CLIENT, SqsEventPublisher, readSqsQueues } from './infrastructure/messaging/sqs';
import { SqsShutdown, sqsClientProvider } from './infrastructure/messaging/sqs.provider';
import { PrometheusTelemetry } from './infrastructure/observability/prometheus-telemetry';
import { TracingShutdown } from './infrastructure/observability/tracing.provider';
import { MikroOrmMaintenanceStore } from './infrastructure/persistence/mikro-orm-maintenance-store';
import { MikroOrmOutboxStore } from './infrastructure/persistence/mikro-orm-outbox-store';
import { MikroOrmTransactionRunner } from './infrastructure/persistence/mikro-orm-transaction-runner';
import { MikroOrmWageringQueries } from './infrastructure/persistence/mikro-orm-wagering-queries';
import { MIKRO_ORM, OrmShutdown, ormProvider } from './infrastructure/persistence/orm.provider';
import { SystemClock, UuidV7Generator } from './infrastructure/system';
import { JwtTokenVerifier, readJwtVerifierConfig } from './infrastructure/auth/jwt-token-verifier';
import { AUTH_ENABLED, AuthGuard } from './interfaces/http/auth.guard';
import { HealthController } from './interfaces/http/health.controller';
import { HttpErrorFilter } from './interfaces/http/http-error.filter';
import { DocsController } from './interfaces/http/docs.controller';
import { LedgerController } from './interfaces/http/ledger.controller';
import { MetricsController } from './interfaces/http/metrics.controller';
import { requestContextMiddleware } from './interfaces/http/request-context.middleware';
import { WageringController } from './interfaces/http/wagering.controller';
import { WalletsController } from './interfaces/http/wallets.controller';
import {
  WagerTransactionConsumer,
  defaultConsumerOptions,
} from './interfaces/sqs/wager-transaction-consumer';
import { BackgroundWorkers } from './interfaces/workers/background-workers';

@Module({
  controllers: [
    HealthController,
    MetricsController,
    WalletsController,
    WageringController,
    LedgerController,
    DocsController,
  ],
  providers: [
    ormProvider,
    OrmShutdown,
    TracingShutdown,
    sqsClientProvider,
    SqsShutdown,
    AuthGuard,
    BackgroundWorkers,
    {
      provide: AUTH_ENABLED,
      useFactory: () => process.env.AUTH_ENABLED === 'true',
    },
    {
      provide: TOKEN_VERIFIER,
      useFactory: (enabled: boolean): TokenVerifier =>
        enabled
          ? new JwtTokenVerifier(readJwtVerifierConfig())
          : { verify: async () => ANONYMOUS_PRINCIPAL },
      inject: [AUTH_ENABLED],
    },
    { provide: APP_FILTER, useClass: HttpErrorFilter },
    { provide: CLOCK, useValue: new SystemClock() },
    { provide: ID_GENERATOR, useValue: new UuidV7Generator() },
    {
      provide: OUTBOX_STORE,
      useFactory: (orm: MikroORM) => new MikroOrmOutboxStore(orm),
      inject: [MIKRO_ORM],
    },
    {
      provide: TELEMETRY,
      useFactory: (outbox: MikroOrmOutboxStore, sqs: SQSClient) => {
        const telemetry = new PrometheusTelemetry();
        const deadLetterQueueUrl = readSqsQueues().transactionsDlqUrl;
        telemetry.registerGauges({
          outboxStats: () => outbox.stats(new Date()),
          deadLetterDepth: async () => {
            const response = await sqs.send(
              new GetQueueAttributesCommand({
                QueueUrl: deadLetterQueueUrl,
                AttributeNames: ['ApproximateNumberOfMessages'],
              }),
            );
            return Number(response.Attributes?.ApproximateNumberOfMessages ?? 0);
          },
        });
        return telemetry;
      },
      inject: [OUTBOX_STORE, SQS_CLIENT],
    },
    {
      provide: TRANSACTION_RUNNER,
      useFactory: (orm: MikroORM, telemetry: Telemetry) =>
        new MikroOrmTransactionRunner(orm, telemetry),
      inject: [MIKRO_ORM, TELEMETRY],
    },
    {
      provide: WAGERING_QUERIES,
      useFactory: (orm: MikroORM) => new MikroOrmWageringQueries(orm),
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
      provide: MAINTENANCE_STORE,
      useFactory: (orm: MikroORM) => new MikroOrmMaintenanceStore(orm),
      inject: [MIKRO_ORM],
    },
    {
      provide: PurgeExpiredMessages,
      useFactory: (store: MaintenanceStore, clock: Clock, telemetry: Telemetry) =>
        new PurgeExpiredMessages(store, clock, retentionPolicyFromEnv(), telemetry),
      inject: [MAINTENANCE_STORE, CLOCK, TELEMETRY],
    },
    {
      provide: ReconcileAllWallets,
      useFactory: (store: MaintenanceStore, telemetry: Telemetry) =>
        new ReconcileAllWallets(store, telemetry),
      inject: [MAINTENANCE_STORE, TELEMETRY],
    },
    {
      provide: GetTrialBalance,
      useFactory: (queries: WageringQueries) => new GetTrialBalance(queries),
      inject: [WAGERING_QUERIES],
    },
    {
      provide: GetWalletLedger,
      useFactory: (queries: WageringQueries) => new GetWalletLedger(queries),
      inject: [WAGERING_QUERIES],
    },
    {
      provide: ReconcileWallet,
      useFactory: (queries: WageringQueries, telemetry: Telemetry) =>
        new ReconcileWallet(queries, telemetry),
      inject: [WAGERING_QUERIES, TELEMETRY],
    },
    {
      provide: ProcessWagerTransaction,
      useFactory: (
        runner: TransactionRunner,
        clock: Clock,
        ids: IdGenerator,
        telemetry: Telemetry,
      ) =>
        new ProcessWagerTransaction(runner, clock, ids, ReferenceRetryPolicy.default(), telemetry),
      inject: [TRANSACTION_RUNNER, CLOCK, ID_GENERATOR, TELEMETRY],
    },
    {
      provide: RetryPendingReferences,
      useFactory: (
        runner: TransactionRunner,
        queries: WageringQueries,
        clock: Clock,
        ids: IdGenerator,
        telemetry: Telemetry,
      ) =>
        new RetryPendingReferences(
          runner,
          queries,
          clock,
          ids,
          ReferenceRetryPolicy.default(),
          telemetry,
        ),
      inject: [TRANSACTION_RUNNER, WAGERING_QUERIES, CLOCK, ID_GENERATOR, TELEMETRY],
    },
    {
      provide: PublishOutboxEvents,
      useFactory: (
        outbox: MikroOrmOutboxStore,
        publisher: EventPublisher,
        clock: Clock,
        telemetry: Telemetry,
      ) => new PublishOutboxEvents(outbox, publisher, clock, telemetry),
      inject: [OUTBOX_STORE, EVENT_PUBLISHER, CLOCK, TELEMETRY],
    },
    {
      provide: WagerTransactionConsumer,
      useFactory: (sqs: SQSClient, processWager: ProcessWagerTransaction, telemetry: Telemetry) => {
        const queues = readSqsQueues();
        return new WagerTransactionConsumer(
          sqs,
          processWager,
          defaultConsumerOptions(queues.transactionsQueueUrl, queues.transactionsDlqUrl),
          telemetry,
        );
      },
      inject: [SQS_CLIENT, ProcessWagerTransaction, TELEMETRY],
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(requestContextMiddleware).forRoutes('*');
  }
}
