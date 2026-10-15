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
import { TransactionNotFoundError } from '@/application/errors';
import { WAGERING_QUERIES, type WageringQueries } from '@/application/ports';
import { ProcessWagerTransaction } from '@/application/wagering/process-wager-transaction';
import { type TransactionView, toTransactionView } from '@/application/wagering/transaction-view';
import type { WagerTransactionResult } from '@/application/wagering/wager-transaction-result';
import { WagerTransactionStatus } from '@/domain/wagering/wager-transaction';
import { AuthGuard } from './auth.guard';
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
  async submit(
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
    const correlationId = resolveCorrelationId(correlationHeader);

    const result = await this.processWager.execute({
      ...input,
      idempotencyKey: idempotencyKey.trim(),
      correlationId,
    });

    response.setHeader(CORRELATION_HEADER, correlationId);
    response.status(statusFor(result));
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  async findById(@Param('transactionId') transactionId: string): Promise<TransactionView> {
    const tx = await this.queries.findTransaction(transactionId);
    if (!tx) {
      throw new TransactionNotFoundError(transactionId);
    }
    return toTransactionView(tx);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async findByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<TransactionView> {
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
