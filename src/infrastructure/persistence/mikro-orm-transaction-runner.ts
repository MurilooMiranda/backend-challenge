import {
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { InfrastructureUnavailableError, UniqueViolationError } from '@/application/errors';
import type { TransactionRunner, WageringUnitOfWork } from '@/application/ports';
import { MikroOrmWageringUnitOfWork } from './mikro-orm-unit-of-work';

export function translatePersistenceError(error: unknown): unknown {
  if (error instanceof UniqueConstraintViolationException) {
    return new UniqueViolationError((error as { constraint?: string }).constraint);
  }
  if (
    error instanceof ConnectionException ||
    error instanceof DeadlockException ||
    error instanceof LockWaitTimeoutException
  ) {
    return new InfrastructureUnavailableError(error.message);
  }
  if (isConnectionRefused(error)) {
    return new InfrastructureUnavailableError((error as Error).message);
  }
  return error;
}

function isConnectionRefused(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === '57P01';
}

export class MikroOrmTransactionRunner implements TransactionRunner {
  constructor(private readonly orm: MikroORM) {}

  async run<T>(work: (uow: WageringUnitOfWork) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em
        .fork()
        .transactional((em) => work(new MikroOrmWageringUnitOfWork(em)));
    } catch (error) {
      throw translatePersistenceError(error);
    }
  }
}
