import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { Role } from '@/application/auth';
import { GetTrialBalance, type TrialBalance } from '@/application/ledger/get-trial-balance';
import { AuthGuard, Roles } from './auth.guard';

@Controller('ledger')
@UseGuards(AuthGuard)
export class LedgerController {
  constructor(@Inject(GetTrialBalance) private readonly getTrialBalance: GetTrialBalance) {}

  @Get('trial-balance')
  @Roles(Role.Operator)
  async trialBalance(@Query('currency') currency?: string): Promise<TrialBalance> {
    return this.getTrialBalance.execute(currency ?? 'BRL');
  }
}
