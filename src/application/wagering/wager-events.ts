import type { EventContext, IntegrationEvent } from '@/domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '@/domain/events/wagering-events';
import type { WalletLedgerEntry } from '@/domain/ledger/wallet-ledger-entry';
import { OutboxMessage } from '@/domain/messaging/outbox-message';
import { type WagerTransaction, WagerTransactionStatus } from '@/domain/wagering/wager-transaction';
import type { Wallet } from '@/domain/wallet/wallet';

export function settlementEvents(
  tx: WagerTransaction,
  wallet: Wallet,
  entry: WalletLedgerEntry | undefined,
  nextContext: () => EventContext,
): OutboxMessage[] {
  const events: IntegrationEvent<unknown>[] = [];

  switch (tx.status) {
    case WagerTransactionStatus.Processed:
      events.push(WagerTransactionProcessed.from(tx, nextContext()));
      if (entry) {
        events.push(WalletBalanceChanged.from(wallet, entry, nextContext()));
      }
      break;
    case WagerTransactionStatus.Rejected:
      events.push(WagerTransactionRejected.from(tx, nextContext()));
      break;
    case WagerTransactionStatus.PendingReference:
      events.push(WagerTransactionPendingReference.from(tx, nextContext()));
      break;
    default:
      break;
  }

  return events.map((event) => OutboxMessage.enqueue(event));
}
