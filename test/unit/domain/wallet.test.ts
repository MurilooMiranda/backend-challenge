import { describe, expect, it } from 'bun:test';
import { LedgerDirection, type WalletLedgerEntry } from '@/domain/ledger/wallet-ledger-entry';
import { Money } from '@/domain/money/money';
import { CurrencyMismatchError, InvalidMoneyError } from '@/domain/money/money.errors';
import { Wallet } from '@/domain/wallet/wallet';
import { InsufficientFundsError } from '@/domain/wallet/wallet.errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00.000Z');
const later = new Date('2026-01-01T00:05:00.000Z');

function openWallet(initial = '100.00') {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initial),
    openingTransactionId: 'tx-opening',
    openingEntryId: 'entry-opening',
    at,
  });
}

let seq = 0;
const movement = (amount: string) => ({
  transactionId: `tx-${++seq}`,
  entryId: `entry-${seq}`,
  money: brl(amount),
  at: later,
});

function replay(currency: string, entries: WalletLedgerEntry[]): Money {
  return entries.reduce(
    (acc, e) => (e.direction === LedgerDirection.Credit ? acc.add(e.money) : acc.subtract(e.money)),
    Money.zero(currency),
  );
}

describe('Wallet', () => {
  describe('open', () => {
    it('starts at version 1 with an OPENING credit entry', () => {
      const { wallet, openingEntry } = openWallet('100.00');
      expect(wallet.version).toBe(1);
      expect(wallet.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(wallet.currency).toBe('BRL');
      expect(openingEntry).toBeDefined();
      expect(openingEntry!.direction).toBe(LedgerDirection.Credit);
      expect(openingEntry!.transactionId).toBe('tx-opening');
      expect(openingEntry!.balanceBefore.isZero()).toBe(true);
      expect(openingEntry!.balanceAfter.equals(brl('100.00'))).toBe(true);
    });

    it('zero initial balance produces no ledger entry', () => {
      const { wallet, openingEntry } = openWallet('0.00');
      expect(wallet.balance.isZero()).toBe(true);
      expect(wallet.version).toBe(1);
      expect(openingEntry).toBeUndefined();
    });

    it('rejects a negative initial balance', () => {
      expect(() =>
        Wallet.open({
          id: 'w',
          playerId: 'p',
          initialBalance: brl('0.00').subtract(brl('1.00')),
          openingTransactionId: 't',
          openingEntryId: 'e',
          at,
        }),
      ).toThrow(InvalidMoneyError);
    });
  });

  describe('debit', () => {
    it('decreases balance, bumps version and returns a matching entry', () => {
      const { wallet } = openWallet('100.00');
      const entry = wallet.debit(movement('25.00'));

      expect(wallet.balance.equals(brl('75.00'))).toBe(true);
      expect(wallet.version).toBe(2);
      expect(wallet.updatedAt).toEqual(later);
      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.walletId).toBe('wallet-1');
      expect(entry.balanceBefore.equals(brl('100.00'))).toBe(true);
      expect(entry.balanceAfter.equals(brl('75.00'))).toBe(true);
    });

    it('allows debiting the exact balance', () => {
      const { wallet } = openWallet('80.00');
      wallet.debit(movement('80.00'));
      expect(wallet.balance.isZero()).toBe(true);
    });

    it('rejects insufficient funds and leaves the wallet untouched', () => {
      const { wallet } = openWallet('100.00');
      expect(() => wallet.debit(movement('100.01'))).toThrow(InsufficientFundsError);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
      expect(wallet.version).toBe(1);
      expect(wallet.updatedAt).toEqual(at);
    });

    it('section 8 scenario, sequential: 100.00 and two bets of 80.00', () => {
      const { wallet } = openWallet('100.00');
      wallet.debit(movement('80.00'));
      expect(() => wallet.debit(movement('80.00'))).toThrow(InsufficientFundsError);
      expect(wallet.balance.equals(brl('20.00'))).toBe(true);
    });
  });

  describe('credit', () => {
    it('increases balance and bumps version', () => {
      const { wallet } = openWallet('10.00');
      const entry = wallet.credit(movement('5.50'));
      expect(wallet.balance.equals(brl('15.50'))).toBe(true);
      expect(wallet.version).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.Credit);
    });
  });

  describe('guards', () => {
    it('rejects a different currency', () => {
      const { wallet } = openWallet('10.00');
      const usd = { ...movement('1.00'), money: Money.from({ amount: '1.00', currency: 'USD' }) };
      expect(() => wallet.debit(usd)).toThrow(CurrencyMismatchError);
      expect(() => wallet.credit(usd)).toThrow(CurrencyMismatchError);
      expect(wallet.version).toBe(1);
    });

    it('rejects zero amount movements', () => {
      const { wallet } = openWallet('10.00');
      expect(() => wallet.credit(movement('0.00'))).toThrow(InvalidMoneyError);
      expect(() => wallet.debit(movement('0.00'))).toThrow(InvalidMoneyError);
      expect(wallet.version).toBe(1);
    });
  });

  describe('invariants', () => {
    it('balance always equals the balance rebuilt from the ledger', () => {
      const { wallet, openingEntry } = openWallet('100.00');
      const entries = [openingEntry!];

      entries.push(wallet.debit(movement('30.00')));
      entries.push(wallet.credit(movement('12.34')));
      entries.push(wallet.debit(movement('0.01')));
      try {
        wallet.debit(movement('1000.00'));
      } catch {}
      entries.push(wallet.credit(movement('50.00')));

      expect(replay('BRL', entries).equals(wallet.balance)).toBe(true);
      expect(wallet.version).toBe(1 + 4);
      expect(entries.every((e) => e.isBalanced())).toBe(true);
    });
  });

  describe('rehydrate', () => {
    it('restores persisted state without side effects', () => {
      const wallet = Wallet.rehydrate({
        id: 'wallet-9',
        playerId: 'player-9',
        currency: 'BRL',
        balance: brl('42.00'),
        version: 7,
        createdAt: at,
        updatedAt: later,
      });
      expect(wallet.balance.equals(brl('42.00'))).toBe(true);
      expect(wallet.version).toBe(7);
      expect(wallet.updatedAt).toEqual(later);
    });
  });
});
