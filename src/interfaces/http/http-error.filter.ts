import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { ForbiddenError, UnauthenticatedError } from '@/application/auth';
import {
  ApplicationError,
  IdempotencyConflictError,
  InfrastructureUnavailableError,
  InvalidCommandError,
  TransactionNotFoundError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '@/application/errors';
import { DomainError } from '@/domain/shared/domain-error';
import { RequestValidationError } from './schemas';

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.map(exception);

    if (status === HttpStatus.UNAUTHORIZED) {
      response.setHeader('WWW-Authenticate', 'Bearer realm="wagering"');
    }
    if (status === HttpStatus.SERVICE_UNAVAILABLE) {
      response.setHeader('Retry-After', '1');
    }
    if (status >= 500) {
      this.logger.error(exception instanceof Error ? exception.message : String(exception));
    }
    response.status(status).json(body);
  }

  private map(exception: unknown): { status: number; body: ErrorBody } {
    if (exception instanceof UnauthenticatedError) {
      return this.error(HttpStatus.UNAUTHORIZED, exception.code, exception.message);
    }
    if (exception instanceof ForbiddenError) {
      return this.error(HttpStatus.FORBIDDEN, exception.code, exception.message);
    }
    if (exception instanceof RequestValidationError) {
      return this.error(
        HttpStatus.BAD_REQUEST,
        exception.code,
        exception.message,
        exception.issues,
      );
    }
    if (exception instanceof DomainError || exception instanceof InvalidCommandError) {
      return this.error(HttpStatus.BAD_REQUEST, exception.code, exception.message);
    }
    if (
      exception instanceof IdempotencyConflictError ||
      exception instanceof WalletAlreadyExistsError
    ) {
      return this.error(HttpStatus.CONFLICT, exception.code, exception.message);
    }
    if (exception instanceof WalletNotFoundError || exception instanceof TransactionNotFoundError) {
      return this.error(HttpStatus.NOT_FOUND, exception.code, exception.message);
    }
    if (exception instanceof InfrastructureUnavailableError) {
      return this.error(
        HttpStatus.SERVICE_UNAVAILABLE,
        exception.code,
        'Service temporarily unavailable, retry later',
      );
    }
    if (exception instanceof ApplicationError) {
      return this.error(HttpStatus.INTERNAL_SERVER_ERROR, exception.code, exception.message);
    }
    if (exception instanceof HttpException) {
      return this.error(exception.getStatus(), 'HTTP_ERROR', exception.message);
    }
    return this.error(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', 'Unexpected error');
  }

  private error(
    status: number,
    code: string,
    message: string,
    details?: unknown,
  ): { status: number; body: ErrorBody } {
    return {
      status,
      body: { error: { code, message, ...(details !== undefined ? { details } : {}) } },
    };
  }
}
