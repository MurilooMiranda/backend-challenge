import { Money } from '../money/money';
import { CurrencyMismatchError } from '../money/money.errors';
import { DomainError } from '../shared/domain-error';
import type { LedgerAccount } from './ledger-account';
import { LedgerDirection, type WalletLedgerEntry } from './wallet-ledger-entry';

export class UnbalancedJournalEntryError extends DomainError {
  readonly code = 'JOURNAL_ENTRY_UNBALANCED';

  constructor(reason: string) {
    super(`Unbalanced journal entry: ${reason}`);
  }
}

export interface Posting {
  readonly accountCode: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
}

export interface JournalEntryState {
  id: string;
  transactionId: string;
  postings: Posting[];
  createdAt: Date;
}

export interface WalletMovementJournalProps {
  id: string;
  entry: WalletLedgerEntry;
  playerAccount: LedgerAccount;
  counterparty: LedgerAccount;
}

const opposite = (direction: LedgerDirection) =>
  direction === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;

export class JournalEntry {
  readonly id: string;
  readonly transactionId: string;
  readonly currency: string;
  readonly postings: readonly Posting[];
  readonly createdAt: Date;

  private constructor(state: JournalEntryState) {
    this.id = state.id;
    this.transactionId = state.transactionId;
    this.currency = state.postings[0]?.money.currency ?? '';
    this.postings = Object.freeze(state.postings.map((posting) => Object.freeze({ ...posting })));
    this.createdAt = state.createdAt;
  }

  static create(state: JournalEntryState): JournalEntry {
    const { postings } = state;
    if (postings.length < 2) {
      throw new UnbalancedJournalEntryError('at least two postings are required');
    }
    const currency = postings[0]!.money.currency;
    for (const posting of postings) {
      if (posting.money.currency !== currency) {
        throw new CurrencyMismatchError(currency, posting.money.currency);
      }
      if (!posting.money.isPositive()) {
        throw new UnbalancedJournalEntryError('posting amounts must be positive');
      }
    }
    if (new Set(postings.map((posting) => posting.accountCode)).size !== postings.length) {
      throw new UnbalancedJournalEntryError('an account can appear only once per entry');
    }

    const entry = new JournalEntry(state);
    if (!entry.isBalanced()) {
      throw new UnbalancedJournalEntryError(
        `debits ${entry.total(LedgerDirection.Debit)} != credits ${entry.total(LedgerDirection.Credit)}`,
      );
    }
    return entry;
  }

  static forWalletMovement(props: WalletMovementJournalProps): JournalEntry {
    const { entry, playerAccount, counterparty } = props;
    if (playerAccount.walletId !== entry.walletId) {
      throw new UnbalancedJournalEntryError('player account does not belong to the wallet entry');
    }
    return JournalEntry.create({
      id: props.id,
      transactionId: entry.transactionId,
      createdAt: entry.createdAt,
      postings: [
        { accountCode: playerAccount.code, direction: entry.direction, money: entry.money },
        {
          accountCode: counterparty.code,
          direction: opposite(entry.direction),
          money: entry.money,
        },
      ],
    });
  }

  static rehydrate(state: JournalEntryState): JournalEntry {
    return new JournalEntry(state);
  }

  isBalanced(): boolean {
    return this.total(LedgerDirection.Debit).equals(this.total(LedgerDirection.Credit));
  }

  total(direction: LedgerDirection): Money {
    return this.postings
      .filter((posting) => posting.direction === direction)
      .reduce((sum, posting) => sum.add(posting.money), Money.zero(this.currency));
  }
}
