import type { MoneyProps } from '@/domain/money/money';
import { WalletNotFoundError } from '../errors';
import type { WageringQueries } from '../ports';
import { type Telemetry, noopTelemetry } from '../telemetry';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  journalBalance: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export class ReconcileWallet {
  constructor(
    private readonly queries: WageringQueries,
    private readonly telemetry: Telemetry = noopTelemetry,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const snapshot = await this.queries.reconciliationSnapshot(walletId);
    if (!snapshot) {
      throw new WalletNotFoundError(walletId);
    }

    const stored = snapshot.wallet.balance;
    const calculated = snapshot.credits.subtract(snapshot.debits);
    const difference = stored.subtract(calculated);
    const journal = snapshot.journalCredits.subtract(snapshot.journalDebits);
    const consistent = difference.isZero() && journal.equals(stored);

    this.telemetry.reconciliationChecked({
      walletId,
      consistent,
      difference: difference.toJSON().amount,
      checkedEntries: snapshot.entries,
    });

    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      journalBalance: journal.toJSON(),
      consistent,
      checkedEntries: snapshot.entries,
    };
  }
}
