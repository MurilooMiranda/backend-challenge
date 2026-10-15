import { describe, expect, it } from 'bun:test';
import { JournalEntry, UnbalancedJournalEntryError } from '@/domain/ledger/journal-entry';
import { LedgerAccount, LedgerAccountKind } from '@/domain/ledger/ledger-account';
import { LedgerDirection, WalletLedgerEntry } from '@/domain/ledger/wallet-ledger-entry';
import { Money } from '@/domain/money/money';
import { CurrencyMismatchError } from '@/domain/money/money.errors';
import { WagerTransactionKind } from '@/domain/wagering/wager-transaction';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00.000Z');

const posting = (accountCode: string, direction: LedgerDirection, amount: string) => ({
  accountCode,
  direction,
  money: brl(amount),
});

function walletEntry(direction: LedgerDirection, amount: string) {
  return WalletLedgerEntry.create({
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'tx-1',
    direction,
    money: brl(amount),
    balanceBefore: brl('100.00'),
    balanceAfter:
      direction === LedgerDirection.Credit
        ? brl('100.00').add(brl(amount))
        : brl('100.00').subtract(brl(amount)),
    createdAt: at,
  });
}

describe('LedgerAccount', () => {
  it('builds stable account codes per kind', () => {
    expect(LedgerAccount.playerWallet('w-1', 'BRL')).toMatchObject({
      code: 'PLAYER:w-1',
      kind: LedgerAccountKind.PlayerWallet,
      walletId: 'w-1',
    });
    expect(LedgerAccount.house('provider-a', 'BRL').code).toBe('HOUSE:provider-a:BRL');
    expect(LedgerAccount.funding('BRL').code).toBe('FUNDING:BRL');
  });

  it('OPENING is funded externally; every game operation settles against the house', () => {
    expect(
      LedgerAccount.counterpartyFor(WagerTransactionKind.Opening, 'internal', 'BRL').kind,
    ).toBe(LedgerAccountKind.Funding);
    for (const kind of [
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ]) {
      expect(LedgerAccount.counterpartyFor(kind, 'provider-a', 'BRL').code).toBe(
        'HOUSE:provider-a:BRL',
      );
    }
  });
});

describe('JournalEntry', () => {
  it('accepts balanced postings', () => {
    const journal = JournalEntry.create({
      id: 'j-1',
      transactionId: 'tx-1',
      createdAt: at,
      postings: [
        posting('A', LedgerDirection.Debit, '10.00'),
        posting('B', LedgerDirection.Credit, '7.50'),
        posting('C', LedgerDirection.Credit, '2.50'),
      ],
    });
    expect(journal.isBalanced()).toBe(true);
    expect(journal.total(LedgerDirection.Debit).equals(brl('10.00'))).toBe(true);
    expect(journal.currency).toBe('BRL');
  });

  it('rejects unbalanced postings', () => {
    expect(() =>
      JournalEntry.create({
        id: 'j-1',
        transactionId: 'tx-1',
        createdAt: at,
        postings: [
          posting('A', LedgerDirection.Debit, '10.00'),
          posting('B', LedgerDirection.Credit, '9.99'),
        ],
      }),
    ).toThrow(UnbalancedJournalEntryError);
  });

  it('requires at least two postings, positive amounts and distinct accounts', () => {
    const create = (postings: ReturnType<typeof posting>[]) => () =>
      JournalEntry.create({ id: 'j-1', transactionId: 'tx-1', createdAt: at, postings });

    expect(create([posting('A', LedgerDirection.Debit, '1.00')])).toThrow(
      UnbalancedJournalEntryError,
    );
    expect(
      create([
        posting('A', LedgerDirection.Debit, '0.00'),
        posting('B', LedgerDirection.Credit, '0.00'),
      ]),
    ).toThrow(UnbalancedJournalEntryError);
    expect(
      create([
        posting('A', LedgerDirection.Debit, '1.00'),
        posting('A', LedgerDirection.Credit, '1.00'),
      ]),
    ).toThrow(UnbalancedJournalEntryError);
  });

  it('rejects mixed currencies', () => {
    expect(() =>
      JournalEntry.create({
        id: 'j-1',
        transactionId: 'tx-1',
        createdAt: at,
        postings: [
          posting('A', LedgerDirection.Debit, '1.00'),
          {
            accountCode: 'B',
            direction: LedgerDirection.Credit,
            money: Money.from({ amount: '1.00', currency: 'USD' }),
          },
        ],
      }),
    ).toThrow(CurrencyMismatchError);
  });

  it('a wallet debit becomes player debit / counterparty credit', () => {
    const journal = JournalEntry.forWalletMovement({
      id: 'j-1',
      entry: walletEntry(LedgerDirection.Debit, '25.00'),
      playerAccount: LedgerAccount.playerWallet('wallet-1', 'BRL'),
      counterparty: LedgerAccount.house('provider-a', 'BRL'),
    });
    expect(journal.transactionId).toBe('tx-1');
    expect(
      journal.postings.map((p) => [p.accountCode, p.direction, p.money.toJSON().amount]),
    ).toEqual([
      ['PLAYER:wallet-1', LedgerDirection.Debit, '25.00'],
      ['HOUSE:provider-a:BRL', LedgerDirection.Credit, '25.00'],
    ]);
  });

  it('a wallet credit becomes player credit / counterparty debit', () => {
    const journal = JournalEntry.forWalletMovement({
      id: 'j-1',
      entry: walletEntry(LedgerDirection.Credit, '40.00'),
      playerAccount: LedgerAccount.playerWallet('wallet-1', 'BRL'),
      counterparty: LedgerAccount.house('provider-a', 'BRL'),
    });
    expect(journal.postings.map((p) => p.direction)).toEqual([
      LedgerDirection.Credit,
      LedgerDirection.Debit,
    ]);
    expect(journal.isBalanced()).toBe(true);
  });

  it('refuses a player account from another wallet', () => {
    expect(() =>
      JournalEntry.forWalletMovement({
        id: 'j-1',
        entry: walletEntry(LedgerDirection.Debit, '1.00'),
        playerAccount: LedgerAccount.playerWallet('wallet-OTHER', 'BRL'),
        counterparty: LedgerAccount.house('provider-a', 'BRL'),
      }),
    ).toThrow(UnbalancedJournalEntryError);
  });

  it('postings are immutable', () => {
    const journal = JournalEntry.forWalletMovement({
      id: 'j-1',
      entry: walletEntry(LedgerDirection.Debit, '1.00'),
      playerAccount: LedgerAccount.playerWallet('wallet-1', 'BRL'),
      counterparty: LedgerAccount.house('provider-a', 'BRL'),
    });
    expect(Object.isFrozen(journal.postings)).toBe(true);
    expect(Object.isFrozen(journal.postings[0])).toBe(true);
  });
});
