import { ReferenceRetryPolicy } from '@/domain/wagering/reference-retry-policy';
import { WagerTransactionStatus } from '@/domain/wagering/wager-transaction';
import type {
  Clock,
  IdGenerator,
  PendingReferenceRef,
  TransactionRunner,
  WageringQueries,
} from '../ports';
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
  ) {}

  async execute(limit = 50): Promise<RetryPendingReferencesResult> {
    const due = await this.queries.findDuePendingReferences(this.clock.now(), limit);
    let resolved = 0;
    for (const ref of due) {
      if (await this.retry(ref)) {
        resolved += 1;
      }
    }
    return { checked: due.length, resolved };
  }

  private retry(ref: PendingReferenceRef): Promise<boolean> {
    return this.transactions.run(async (uow) => {
      const wallet = await uow.lockWallet(ref.walletId);
      if (!wallet) {
        return false;
      }

      const tx = await uow.findTransactionById(ref.transactionId);
      const now = this.clock.now();
      if (
        !tx ||
        tx.status !== WagerTransactionStatus.PendingReference ||
        (tx.nextReferenceCheckAt && tx.nextReferenceCheckAt.getTime() > now.getTime())
      ) {
        return false;
      }

      await settleAndStage(uow, tx, wallet, {
        ids: this.ids,
        retryPolicy: this.retryPolicy,
        at: now,
        correlationId: tx.id,
        causationId: tx.id,
        isNew: false,
      });

      return tx.status !== WagerTransactionStatus.PendingReference;
    });
  }
}
