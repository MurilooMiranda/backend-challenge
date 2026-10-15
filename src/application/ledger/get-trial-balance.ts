import { Money, type MoneyProps } from '@/domain/money/money';
import type { WageringQueries } from '../ports';

export interface TrialBalanceAccount {
  code: string;
  kind: string;
  debits: MoneyProps;
  credits: MoneyProps;
  balance: MoneyProps;
}

export interface TrialBalance {
  currency: string;
  accounts: TrialBalanceAccount[];
  playerWallets: { accounts: number; debits: MoneyProps; credits: MoneyProps; balance: MoneyProps };
  totalDebits: MoneyProps;
  totalCredits: MoneyProps;
  journalEntries: number;
  unbalancedJournalEntries: number;
  balanced: boolean;
}

export class GetTrialBalance {
  constructor(private readonly queries: WageringQueries) {}

  async execute(currency: string): Promise<TrialBalance> {
    Money.zero(currency);
    const snapshot = await this.queries.trialBalance(currency);

    const accounts = snapshot.accounts.map((account) => ({
      code: account.code,
      kind: account.kind,
      debits: account.debits.toJSON(),
      credits: account.credits.toJSON(),
      balance: account.credits.subtract(account.debits).toJSON(),
    }));
    const { playerWallets } = snapshot;

    const totalDebits = snapshot.accounts.reduce(
      (sum, account) => sum.add(account.debits),
      playerWallets.debits,
    );
    const totalCredits = snapshot.accounts.reduce(
      (sum, account) => sum.add(account.credits),
      playerWallets.credits,
    );

    return {
      currency,
      accounts,
      playerWallets: {
        accounts: playerWallets.accounts,
        debits: playerWallets.debits.toJSON(),
        credits: playerWallets.credits.toJSON(),
        balance: playerWallets.credits.subtract(playerWallets.debits).toJSON(),
      },
      totalDebits: totalDebits.toJSON(),
      totalCredits: totalCredits.toJSON(),
      journalEntries: snapshot.journalEntries,
      unbalancedJournalEntries: snapshot.unbalancedJournalEntries,
      balanced: totalDebits.equals(totalCredits) && snapshot.unbalancedJournalEntries === 0,
    };
  }
}
