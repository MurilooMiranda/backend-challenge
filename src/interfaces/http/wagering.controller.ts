import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { type Principal, Role, assertProviderAccess, canSeeProvider } from '@/application/auth';
import { TransactionNotFoundError } from '@/application/errors';
import { WAGERING_QUERIES, type WageringQueries } from '@/application/ports';
import { ProcessWagerTransaction } from '@/application/wagering/process-wager-transaction';
import { type TransactionView, toTransactionView } from '@/application/wagering/transaction-view';
import type { WagerTransactionResult } from '@/application/wagering/wager-transaction-result';
import { WagerTransactionStatus } from '@/domain/wagering/wager-transaction';
import { addLogContext } from '@/infrastructure/observability/log-context';
import { AuthGuard, CurrentPrincipal, Roles } from './auth.guard';
import { CORRELATION_HEADER, resolveCorrelationId } from './correlation';
import { RequestValidationError, parseBody, wagerTransactionSchema } from './schemas';

const IDEMPOTENCY_HEADER = 'idempotency-key';

@Controller()
@UseGuards(AuthGuard)
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransaction) private readonly processWager: ProcessWagerTransaction,
    @Inject(WAGERING_QUERIES) private readonly queries: WageringQueries,
  ) {}

  @Post('wagering/transactions')
  @Roles(Role.Provider)
  async submit(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Headers(IDEMPOTENCY_HEADER) idempotencyKey: string | undefined,
    @Headers(CORRELATION_HEADER) correlationHeader: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WagerTransactionResult> {
    if (!idempotencyKey || idempotencyKey.trim() === '') {
      throw new RequestValidationError([
        { path: 'headers.Idempotency-Key', message: 'Idempotency-Key header is required' },
      ]);
    }
    const input = parseBody(wagerTransactionSchema, body);
    assertProviderAccess(principal, input.providerId);
    const correlationId = resolveCorrelationId(correlationHeader);
    addLogContext({ walletId: input.walletId, providerId: input.providerId });

    const result = await this.processWager.execute({
      ...input,
      idempotencyKey: idempotencyKey.trim(),
      correlationId,
      channel: 'http',
    });
    addLogContext({ transactionId: result.transactionId });

    response.setHeader(CORRELATION_HEADER, correlationId);
    response.status(statusFor(result));
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  @Roles(Role.Provider, Role.Operator)
  async findById(
    @CurrentPrincipal() principal: Principal,
    @Param('transactionId') transactionId: string,
  ): Promise<TransactionView> {
    const tx = await this.queries.findTransaction(transactionId);
    if (!tx || !canSeeProvider(principal, tx.providerId)) {
      throw new TransactionNotFoundError(transactionId);
    }
    return toTransactionView(tx);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @Roles(Role.Provider, Role.Operator)
  async findByExternalId(
    @CurrentPrincipal() principal: Principal,
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<TransactionView> {
    assertProviderAccess(principal, providerId);
    const tx = await this.queries.findTransactionByExternalId(providerId, externalTransactionId);
    if (!tx) {
      throw new TransactionNotFoundError(`${providerId}/${externalTransactionId}`);
    }
    return toTransactionView(tx);
  }
}

function statusFor(result: WagerTransactionResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? HttpStatus.OK : HttpStatus.CREATED;
    case WagerTransactionStatus.Rejected:
      return HttpStatus.UNPROCESSABLE_ENTITY;
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.PendingReference:
      return HttpStatus.ACCEPTED;
    case WagerTransactionStatus.Failed:
      return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}
