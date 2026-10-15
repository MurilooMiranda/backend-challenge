import { ReferenceRetryPolicy } from '@/domain/wagering/reference-retry-policy';
import { type WagerTransaction, WagerTransactionStatus } from '@/domain/wagering/wager-transaction';
import type {
  Clock,
  IdGenerator,
  PendingReferenceRef,
  TransactionRunner,
  WageringQueries,
} from '../ports';
import { type Telemetry, noopTelemetry } from '../telemetry';
import { settleAndStage } from './settle-and-stage';

export interface RetryPendingReferencesResult {
  checked: number;
  resolved: number;
}

export class RetryPendingReferences {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly queries: WageringQueries,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly retryPolicy: ReferenceRetryPolicy = ReferenceRetryPolicy.default(),
    private readonly telemetry: Telemetry = noopTelemetry,
  ) {}

  async execute(limit = 50): Promise<RetryPendingReferencesResult> {
    const due = await this.queries.findDuePendingReferences(this.clock.now(), limit);
    let resolved = 0;
    for (const ref of due) {
      const startedAt = performance.now();
      const settled = await this.retry(ref);
      if (settled) {
        resolved += 1;
        this.telemetry.transactionSettled({
          channel: 'worker',
          transactionId: settled.id,
          walletId: settled.walletId,
          providerId: settled.providerId,
          kind: settled.kind,
          status: settled.status,
          failureCode: settled.failureCode ?? null,
          idempotentReplay: false,
          durationSeconds: (performance.now() - startedAt) / 1000,
        });
      }
    }
    return { checked: due.length, resolved };
  }

  private retry(ref: PendingReferenceRef): Promise<WagerTransaction | null> {
    return this.transactions.run(async (uow) => {
      const wallet = await uow.lockWallet(ref.walletId);
      if (!wallet) {
        return null;
      }

      const tx = await uow.findTransactionById(ref.transactionId);
      const now = this.clock.now();
      if (
        !tx ||
        tx.status !== WagerTransactionStatus.PendingReference ||
        (tx.nextReferenceCheckAt && tx.nextReferenceCheckAt.getTime() > now.getTime())
      ) {
        return null;
      }

      await settleAndStage(uow, tx, wallet, {
        ids: this.ids,
        retryPolicy: this.retryPolicy,
        at: now,
        correlationId: tx.id,
        causationId: tx.id,
        isNew: false,
      });

      return tx.status === WagerTransactionStatus.PendingReference ? null : tx;
    });
  }
}
