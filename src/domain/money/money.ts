import { CurrencyMismatchError, InvalidMoneyError } from './money.errors';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const MINOR_UNITS_PER_MAJOR = 100n;
const AMOUNT_PATTERN = /^(0|[1-9]\d*)\.(\d{2})$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    Money.assertValidCurrency(props.currency);

    if (typeof props.amount !== 'string') {
      throw new InvalidMoneyError('amount must be a decimal string');
    }

    const match = AMOUNT_PATTERN.exec(props.amount);
    if (!match) {
      throw new InvalidMoneyError(
        `amount "${props.amount}" must be a non-negative decimal with exactly 2 decimal places`,
      );
    }

    const [, integerPart, fractionPart] = match as unknown as [string, string, string];
    const minorUnits = BigInt(integerPart) * MINOR_UNITS_PER_MAJOR + BigInt(fractionPart);

    return new Money(minorUnits, props.currency);
  }

  static zero(currency: string): Money {
    Money.assertValidCurrency(currency);
    return new Money(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  toJSON(): MoneyProps {
    return { amount: this.formatAmount(), currency: this.currency };
  }

  toString(): string {
    return `${this.formatAmount()} ${this.currency}`;
  }

  private formatAmount(): string {
    const negative = this.minorUnits < 0n;
    const absolute = negative ? -this.minorUnits : this.minorUnits;
    const integerPart = absolute / MINOR_UNITS_PER_MAJOR;
    const fractionPart = (absolute % MINOR_UNITS_PER_MAJOR).toString().padStart(2, '0');
    return `${negative ? '-' : ''}${integerPart}.${fractionPart}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertValidCurrency(currency: string): void {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`currency "${currency}" must be an ISO-4217 code`);
    }
  }
}
