import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  CLOCK,
  type Clock,
  ID_GENERATOR,
  type IdGenerator,
  TRANSACTION_RUNNER,
  type TransactionRunner,
  WAGERING_QUERIES,
} from './application/ports';
import { ProcessWagerTransaction } from './application/wagering/process-wager-transaction';
import { OpenWallet } from './application/wallets/open-wallet';
import { MikroOrmTransactionRunner } from './infrastructure/persistence/mikro-orm-transaction-runner';
import { MikroOrmWageringQueries } from './infrastructure/persistence/mikro-orm-wagering-queries';
import { MIKRO_ORM, OrmShutdown, ormProvider } from './infrastructure/persistence/orm.provider';
import { SystemClock, UuidV7Generator } from './infrastructure/system';
import { AuthGuard } from './interfaces/http/auth.guard';
import { HealthController } from './interfaces/http/health.controller';
import { HttpErrorFilter } from './interfaces/http/http-error.filter';
import { WageringController } from './interfaces/http/wagering.controller';
import { WalletsController } from './interfaces/http/wallets.controller';

@Module({
  controllers: [HealthController, WalletsController, WageringController],
  providers: [
    ormProvider,
    OrmShutdown,
    AuthGuard,
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
  ],
})
export class AppModule {}
