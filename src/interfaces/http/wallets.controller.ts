import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@/application/auth';
import { WalletNotFoundError } from '@/application/errors';
import { WAGERING_QUERIES, type WageringQueries } from '@/application/ports';
import { GetWalletLedger, type LedgerPage } from '@/application/wallets/get-wallet-ledger';
import { OpenWallet } from '@/application/wallets/open-wallet';
import { type ReconciliationReport, ReconcileWallet } from '@/application/wallets/reconcile-wallet';
import { type WalletView, toWalletView } from '@/application/wallets/wallet-view';
import { addLogContext } from '@/infrastructure/observability/log-context';
import { AuthGuard, Roles } from './auth.guard';
import { CORRELATION_HEADER, resolveCorrelationId } from './correlation';
import { RequestValidationError, openWalletSchema, parseBody } from './schemas';

@Controller('wallets')
@UseGuards(AuthGuard)
export class WalletsController {
  constructor(
    @Inject(OpenWallet) private readonly openWallet: OpenWallet,
    @Inject(GetWalletLedger) private readonly getLedger: GetWalletLedger,
    @Inject(ReconcileWallet) private readonly reconcileWallet: ReconcileWallet,
    @Inject(WAGERING_QUERIES) private readonly queries: WageringQueries,
  ) {}

  @Post()
  @Roles(Role.Operator)
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: unknown,
    @Headers(CORRELATION_HEADER) correlationHeader?: string,
  ): Promise<WalletView> {
    const input = parseBody(openWalletSchema, body);
    const wallet = await this.openWallet.execute({
      playerId: input.playerId,
      initialBalance: input.initialBalance,
      correlationId: resolveCorrelationId(correlationHeader),
    });
    addLogContext({ walletId: wallet.id });
    return wallet;
  }

  @Get(':walletId')
  @Roles(Role.Provider, Role.Operator)
  async findOne(@Param('walletId') walletId: string): Promise<WalletView> {
    addLogContext({ walletId });
    const wallet = await this.queries.findWallet(walletId);
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }
    return toWalletView(wallet);
  }

  @Get(':walletId/ledger')
  @Roles(Role.Operator)
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<LedgerPage> {
    addLogContext({ walletId });
    if (limit !== undefined && !/^\d+$/.test(limit)) {
      throw new RequestValidationError([
        { path: 'query.limit', message: 'limit must be a number' },
      ]);
    }
    return this.getLedger.execute({
      walletId,
      cursor: cursor || undefined,
      limit: limit === undefined ? undefined : Number(limit),
    });
  }

  @Post(':walletId/reconciliation')
  @Roles(Role.Operator)
  @HttpCode(HttpStatus.OK)
  async reconcile(@Param('walletId') walletId: string): Promise<ReconciliationReport> {
    addLogContext({ walletId });
    return this.reconcileWallet.execute(walletId);
  }
}
