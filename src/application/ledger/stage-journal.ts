import { JournalEntry } from '@/domain/ledger/journal-entry';
import { LedgerAccount } from '@/domain/ledger/ledger-account';
import type { WalletLedgerEntry } from '@/domain/ledger/wallet-ledger-entry';
import type { WagerTransactionKind } from '@/domain/wagering/wager-transaction';
import type { IdGenerator, WageringUnitOfWork } from '../ports';

export async function stageJournal(
  uow: WageringUnitOfWork,
  entry: WalletLedgerEntry,
  kind: WagerTransactionKind,
  providerId: string,
  ids: IdGenerator,
): Promise<JournalEntry> {
  const currency = entry.money.currency;
  const playerAccount = LedgerAccount.playerWallet(entry.walletId, currency);
  const counterparty = LedgerAccount.counterpartyFor(kind, providerId, currency);
  const journal = JournalEntry.forWalletMovement({
    id: ids.next(),
    entry,
    playerAccount,
    counterparty,
  });
  await uow.ensureAccounts([counterparty]);
  uow.addJournalEntry(journal);
  return journal;
}
