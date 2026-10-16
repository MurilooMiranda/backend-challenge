import type { MaintenanceStore, WalletConsistencyRow } from '../ports';
import { type Telemetry, noopTelemetry } from '../telemetry';

export interface ReconcileAllWalletsResult {
  skipped: boolean;
  checked: number;
  divergent: WalletConsistencyRow[];
}

export class ReconcileAllWallets {
  constructor(
    private readonly store: MaintenanceStore,
    private readonly telemetry: Telemetry = noopTelemetry,
    private readonly batchSize = 500,
  ) {}

  async execute(): Promise<ReconcileAllWalletsResult> {
    const startedAt = performance.now();
    const scan = await this.store.scanWalletConsistency(this.batchSize);
    if (!scan) {
      return { skipped: true, checked: 0, divergent: [] };
    }

    for (const wallet of scan.divergent) {
      this.telemetry.reconciliationChecked({
        walletId: wallet.walletId,
        consistent: false,
        difference: wallet.stored.subtract(wallet.ledger).toJSON().amount,
        checkedEntries: 0,
      });
    }
    this.telemetry.reconciliationScanCompleted({
      checked: scan.checked,
      divergent: scan.divergent.length,
      durationSeconds: (performance.now() - startedAt) / 1000,
    });

    return { skipped: false, checked: scan.checked, divergent: scan.divergent };
  }
}
