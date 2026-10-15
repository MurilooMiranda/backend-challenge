import type { ReferenceRetryPolicy } from '@/domain/wagering/reference-retry-policy';
import { WagerSettlement } from '@/domain/wagering/wager-settlement';
import { type WagerTransaction, WagerTransactionStatus } from '@/domain/wagering/wager-transaction';
import type { Wallet } from '@/domain/wallet/wallet';
import type { IdGenerator, WageringUnitOfWork } from '../ports';
import { settlementEvents } from './wager-events';

export interface SettleAndStageOptions {
  ids: IdGenerator;
  retryPolicy: ReferenceRetryPolicy;
  at: Date;
  correlationId: string;
  causationId?: string | undefined;
  isNew: boolean;
}

export async function settleAndStage(
  uow: WageringUnitOfWork,
  tx: WagerTransaction,
  wallet: Wallet,
  options: SettleAndStageOptions,
): Promise<void> {
  const previousStatus = tx.status;

  const reference =
    tx.requiresReference() && tx.referenceExternalTransactionId
      ? ((await uow.findTransactionByExternalId(
          tx.providerId,
          tx.referenceExternalTransactionId,
        )) ?? undefined)
      : undefined;
  const referenceAlreadyReversed = reference ? await uow.hasProcessedReversal(reference.id) : false;

  const { entry } = WagerSettlement.settle(tx, {
    wallet,
    ...(reference ? { reference } : {}),
    referenceAlreadyReversed,
    entryId: options.ids.next(),
    at: options.at,
    retryPolicy: options.retryPolicy,
  });

  if (options.isNew) {
    uow.addTransaction(tx);
  } else {
    uow.saveTransaction(tx);
  }
  if (entry) {
    uow.addLedgerEntry(entry);
    uow.saveWallet(wallet);
  }

  const stillWaiting =
    previousStatus === WagerTransactionStatus.PendingReference &&
    tx.status === WagerTransactionStatus.PendingReference;
  if (stillWaiting) {
    return;
  }

  uow.addOutboxMessages(
    settlementEvents(tx, wallet, entry, () => ({
      eventId: options.ids.next(),
      correlationId: options.correlationId,
      ...(options.causationId !== undefined ? { causationId: options.causationId } : {}),
      occurredAt: options.at,
    })),
  );
}
