import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { GetTrialBalance, type TrialBalance } from '@/application/ledger/get-trial-balance';
import { AuthGuard } from './auth.guard';

@Controller('ledger')
@UseGuards(AuthGuard)
export class LedgerController {
  constructor(@Inject(GetTrialBalance) private readonly getTrialBalance: GetTrialBalance) {}

  @Get('trial-balance')
  async trialBalance(@Query('currency') currency?: string): Promise<TrialBalance> {
    return this.getTrialBalance.execute(currency ?? 'BRL');
  }
}
