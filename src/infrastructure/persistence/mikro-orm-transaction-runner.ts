import {
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { InfrastructureUnavailableError, UniqueViolationError } from '@/application/errors';
import type { TransactionRunner, WageringUnitOfWork } from '@/application/ports';
import { type Telemetry, noopTelemetry } from '@/application/telemetry';
import { SpanKind, withSpan } from '../observability/tracing';
import { MikroOrmWageringUnitOfWork } from './mikro-orm-unit-of-work';

// Traduz erros do driver para a linguagem da aplicação. Violação de UNIQUE vira um erro que o caso
// de uso sabe refazer; deadlock, timeout de lock e conexão perdida viram indisponibilidade
// transitória (503 no HTTP, nova tentativa na fila).
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
  constructor(
    private readonly orm: MikroORM,
    private readonly telemetry: Telemetry = noopTelemetry,
  ) {}

  async run<T>(work: (uow: WageringUnitOfWork) => Promise<T>): Promise<T> {
    try {
      return await withSpan(
        'db.transaction',
        { 'db.system': 'postgresql' },
        () =>
          this.orm.em
            .fork()
            .transactional((em) => work(new MikroOrmWageringUnitOfWork(em, this.telemetry))),
        { kind: SpanKind.CLIENT },
      );
    } catch (error) {
      throw translatePersistenceError(error);
    }
  }
}
