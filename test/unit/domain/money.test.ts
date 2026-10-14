import { describe, expect, it } from 'bun:test';
import { Money } from '@/domain/money/money';
import { CurrencyMismatchError, InvalidMoneyError } from '@/domain/money/money.errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

describe('Money', () => {
  describe('from', () => {
    it('accepts canonical 2-decimal strings', () => {
      expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
      expect(brl('0.01').toJSON().amount).toBe('0.01');
      expect(brl('0.00').isZero()).toBe(true);
    });

    it.each([
      ['empty', ''],
      ['no decimals', '25'],
      ['one decimal', '25.5'],
      ['three decimals', '25.001'],
      ['negative', '-5.00'],
      ['scientific notation', '1e3'],
      ['NaN', 'NaN'],
      ['Infinity', 'Infinity'],
      ['leading zero', '05.00'],
      ['whitespace', ' 5.00'],
      ['comma separator', '5,00'],
      ['plus sign', '+5.00'],
    ])('rejects %s (%p)', (_label, amount) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    });

    it('rejects a non-string amount coming from untyped input', () => {
      const raw = JSON.parse('{"amount": 25, "currency": "BRL"}');
      expect(() => Money.from(raw)).toThrow(InvalidMoneyError);
    });

    it.each(['brl', 'BR', 'BRLX', 'R$', ''])('rejects invalid currency %p', (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
    });

    it('handles amounts beyond Number.MAX_SAFE_INTEGER exactly', () => {
      const big = brl('90071992547409.93');
      expect(big.add(brl('0.01')).toJSON().amount).toBe('90071992547409.94');
    });
  });

  describe('zero', () => {
    it('creates a zero amount in the given currency', () => {
      const zero = Money.zero('BRL');
      expect(zero.isZero()).toBe(true);
      expect(zero.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    });

    it('rejects an invalid currency', () => {
      expect(() => Money.zero('xx')).toThrow(InvalidMoneyError);
    });
  });

  describe('arithmetic', () => {
    it('adds exactly where floating point does not', () => {
      expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
    });

    it('subtracts exactly', () => {
      expect(brl('100.00').subtract(brl('80.00')).toJSON().amount).toBe('20.00');
      expect(brl('1.15').subtract(brl('0.15')).toJSON().amount).toBe('1.00');
    });

    it('is immutable', () => {
      const a = brl('10.00');
      a.add(brl('5.00'));
      a.subtract(brl('5.00'));
      a.negate();
      expect(a.toJSON().amount).toBe('10.00');
    });

    it('can go negative internally and formats the sign', () => {
      const result = brl('10.00').subtract(brl('10.50'));
      expect(result.isNegative()).toBe(true);
      expect(result.toJSON().amount).toBe('-0.50');
    });

    it('negates and double negation returns the original value', () => {
      const five = brl('5.00');
      expect(five.negate().toJSON().amount).toBe('-5.00');
      expect(five.negate().negate().equals(five)).toBe(true);
    });

    it('negating zero stays zero', () => {
      expect(Money.zero('BRL').negate().toJSON().amount).toBe('0.00');
    });
  });

  describe('predicates', () => {
    it('zero is neither positive nor negative', () => {
      const zero = Money.zero('BRL');
      expect(zero.isPositive()).toBe(false);
      expect(zero.isNegative()).toBe(false);
    });

    it('positive amount', () => {
      expect(brl('0.01').isPositive()).toBe(true);
      expect(brl('0.01').isNegative()).toBe(false);
      expect(brl('0.01').isZero()).toBe(false);
    });

    it('isLessThan compares amounts', () => {
      expect(brl('5.00').isLessThan(brl('10.00'))).toBe(true);
      expect(brl('10.00').isLessThan(brl('5.00'))).toBe(false);
      expect(brl('5.00').isLessThan(brl('5.00'))).toBe(false);
    });

    it('equals compares amount and currency', () => {
      expect(brl('5.00').equals(brl('5.00'))).toBe(true);
      expect(brl('5.00').equals(brl('5.01'))).toBe(false);
    });
  });

  describe('currency safety', () => {
    it('throws on cross-currency operations', () => {
      expect(() => brl('1.00').add(usd('1.00'))).toThrow(CurrencyMismatchError);
      expect(() => brl('1.00').subtract(usd('1.00'))).toThrow(CurrencyMismatchError);
      expect(() => brl('1.00').isLessThan(usd('1.00'))).toThrow(CurrencyMismatchError);
    });

    it('equals is false across currencies instead of throwing', () => {
      expect(brl('1.00').equals(usd('1.00'))).toBe(false);
    });

    it('error carries a stable machine-readable code', () => {
      try {
        brl('1.00').add(usd('1.00'));
        throw new Error('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CurrencyMismatchError);
        expect((error as CurrencyMismatchError).code).toBe('CURRENCY_MISMATCH');
        expect((error as CurrencyMismatchError).name).toBe('CurrencyMismatchError');
      }
    });
  });

  describe('serialization', () => {
    it('toJSON round-trips through from', () => {
      const original = brl('1234.56');
      expect(Money.from(original.toJSON()).equals(original)).toBe(true);
    });

    it('JSON.stringify uses the decimal string, never a number', () => {
      expect(JSON.stringify({ m: brl('7.05') })).toBe('{"m":{"amount":"7.05","currency":"BRL"}}');
    });

    it('toString shows amount and currency', () => {
      expect(brl('25.00').toString()).toBe('25.00 BRL');
      expect(brl('1.00').subtract(brl('2.50')).toString()).toBe('-1.50 BRL');
    });
  });
});
