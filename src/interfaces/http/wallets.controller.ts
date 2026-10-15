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
  UseGuards,
} from '@nestjs/common';
import { WalletNotFoundError } from '@/application/errors';
import { WAGERING_QUERIES, type WageringQueries } from '@/application/ports';
import { OpenWallet } from '@/application/wallets/open-wallet';
import { type WalletView, toWalletView } from '@/application/wallets/wallet-view';
import { AuthGuard } from './auth.guard';
import { CORRELATION_HEADER, resolveCorrelationId } from './correlation';
import { openWalletSchema, parseBody } from './schemas';

@Controller('wallets')
@UseGuards(AuthGuard)
export class WalletsController {
  constructor(
    @Inject(OpenWallet) private readonly openWallet: OpenWallet,
    @Inject(WAGERING_QUERIES) private readonly queries: WageringQueries,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: unknown,
    @Headers(CORRELATION_HEADER) correlationHeader?: string,
  ): Promise<WalletView> {
    const input = parseBody(openWalletSchema, body);
    return this.openWallet.execute({
      playerId: input.playerId,
      initialBalance: input.initialBalance,
      correlationId: resolveCorrelationId(correlationHeader),
    });
  }

  @Get(':walletId')
  async findOne(@Param('walletId') walletId: string): Promise<WalletView> {
    const wallet = await this.queries.findWallet(walletId);
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }
    return toWalletView(wallet);
  }
}
