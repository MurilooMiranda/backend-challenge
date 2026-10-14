import { describe, expect, it } from 'bun:test';
import {
  LedgerDirection,
  UnbalancedLedgerEntryError,
  WalletLedgerEntry,
} from '@/domain/ledger/wallet-ledger-entry';
import { Money } from '@/domain/money/money';
import { CurrencyMismatchError } from '@/domain/money/money.errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00.000Z');

const base = {
  id: 'entry-1',
  walletId: 'wallet-1',
  transactionId: 'tx-1',
  createdAt: at,
};

describe('WalletLedgerEntry', () => {
  it('creates a balanced credit', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('25.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('125.00'),
    });
    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceAfter.toJSON().amount).toBe('125.00');
  });

  it('creates a balanced debit', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('25.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('75.00'),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  it('allows a debit down to exactly zero', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('100.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('0.00'),
    });
    expect(entry.balanceAfter.isZero()).toBe(true);
  });

  it('rejects wrong arithmetic', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('25.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('80.00'),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  it('rejects direction inconsistent with balances', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('25.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('75.00'),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  it.each(['0.00'])('rejects non-positive amount %p', (amount) => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl(amount),
        balanceBefore: brl('10.00'),
        balanceAfter: brl('10.00'),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  it('rejects a negative resulting balance', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('30.00'),
        balanceBefore: brl('20.00'),
        balanceAfter: brl('20.00').subtract(brl('30.00')),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  it('rejects mixed currencies', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: Money.from({ amount: '1.00', currency: 'USD' }),
        balanceBefore: brl('10.00'),
        balanceAfter: brl('11.00'),
      }),
    ).toThrow(CurrencyMismatchError);
  });

  it('rehydrate does not revalidate persisted state', () => {
    const entry = WalletLedgerEntry.rehydrate({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('25.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('80.00'),
    });
    expect(entry.isBalanced()).toBe(false);
  });
});
