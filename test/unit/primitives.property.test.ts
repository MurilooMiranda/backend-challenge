import { describe, expect, it } from 'bun:test';
import fc from 'fast-check';
import { canonicalJson, computeWagerPayloadHash } from '@/application/wagering/payload-hash';
import { decodeLedgerCursor, encodeLedgerCursor } from '@/application/wallets/get-wallet-ledger';
import { WalletBalanceChanged } from '@/domain/events/wagering-events';
import { LedgerDirection, WalletLedgerEntry } from '@/domain/ledger/wallet-ledger-entry';
import { OutboxMessage } from '@/domain/messaging/outbox-message';
import { Money } from '@/domain/money/money';
import { InvalidMoneyError } from '@/domain/money/money.errors';
import { Wallet } from '@/domain/wallet/wallet';

const NUM_RUNS = Number(process.env.FC_NUM_RUNS ?? 500);
const FC_OPTIONS = {
  numRuns: NUM_RUNS,
  ...(process.env.FC_SEED ? { seed: Number(process.env.FC_SEED) } : {}),
};

const centsArb = fc.bigInt({ min: 0n, max: 10n ** 16n });
const toAmount = (cents: bigint) => `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
const brl = (cents: bigint) => Money.from({ amount: toAmount(cents), currency: 'BRL' });

describe('Money properties', () => {
  it('parsing and serializing is lossless for any 2-decimal amount, including huge ones', () => {
    fc.assert(
      fc.property(centsArb, (cents) => {
        expect(brl(cents).toJSON().amount).toBe(toAmount(cents));
      }),
      FC_OPTIONS,
    );
  });

  it('addition is exact, commutative and associative', () => {
    fc.assert(
      fc.property(centsArb, centsArb, centsArb, (a, b, c) => {
        expect(
          brl(a)
            .add(brl(b))
            .equals(brl(a + b)),
        ).toBe(true);
        expect(
          brl(a)
            .add(brl(b))
            .equals(brl(b).add(brl(a))),
        ).toBe(true);
        expect(
          brl(a)
            .add(brl(b))
            .add(brl(c))
            .equals(brl(a).add(brl(b).add(brl(c)))),
        ).toBe(true);
      }),
      FC_OPTIONS,
    );
  });

  it('subtracting what was added returns the original value', () => {
    fc.assert(
      fc.property(centsArb, centsArb, (a, b) => {
        expect(brl(a).add(brl(b)).subtract(brl(b)).equals(brl(a))).toBe(true);
        expect(brl(a).subtract(brl(b)).isNegative()).toBe(a < b);
      }),
      FC_OPTIONS,
    );
  });

  it('rejects any amount that is not a canonical non-negative 2-decimal string', () => {
    const invalid = fc.oneof(
      fc.double().map(String),
      fc.integer().map(String),
      fc.string(),
      fc.tuple(fc.nat(), fc.integer({ min: 3, max: 6 })).map(([n, d]) => `${n}.${'1'.repeat(d)}`),
      fc.integer({ min: 1, max: 99_999 }).map((n) => `-${n}.00`),
    );
    fc.assert(
      fc.property(
        invalid.filter((value) => !/^(0|[1-9]\d*)\.\d{2}$/.test(value)),
        (amount) => {
          expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
        },
      ),
      FC_OPTIONS,
    );
  });
});

describe('ledger entry properties', () => {
  it('create accepts exactly the arithmetically consistent entries', () => {
    fc.assert(
      fc.property(
        centsArb,
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        fc.constantFrom(LedgerDirection.Credit, LedgerDirection.Debit),
        fc.bigInt({ min: -1000n, max: 1000n }),
        (before, amount, direction, skew) => {
          const exactAfter =
            direction === LedgerDirection.Credit ? before + amount : before - amount;
          const after = exactAfter + skew;
          const build = () =>
            WalletLedgerEntry.create({
              id: 'e',
              walletId: 'w',
              transactionId: 't',
              direction,
              money: brl(amount),
              balanceBefore: brl(before),
              balanceAfter: after < 0n ? brl(0n).subtract(brl(-after)) : brl(after),
              createdAt: new Date(0),
            });
          if (skew === 0n && exactAfter >= 0n) {
            expect(build().isBalanced()).toBe(true);
          } else {
            expect(build).toThrow();
          }
        },
      ),
      FC_OPTIONS,
    );
  });
});

const businessFields = fc.record({
  providerId: fc.string({ minLength: 1 }),
  externalTransactionId: fc.string({ minLength: 1 }),
  playerId: fc.string({ minLength: 1 }),
  walletId: fc.uuid(),
  roundId: fc.string({ minLength: 1 }),
  gameId: fc.string({ minLength: 1 }),
  kind: fc.constantFrom('BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'),
  money: fc.record({ amount: centsArb.map(toAmount), currency: fc.constantFrom('BRL', 'USD') }),
  referenceExternalTransactionId: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
});

function shuffleKeys<T extends Record<string, unknown>>(value: T, seed: number): T {
  const keys = Object.keys(value).sort((a, b) => ((a.length * seed) % 7) - ((b.length * seed) % 7));
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as T;
}

describe('idempotency hash properties', () => {
  it('canonical JSON is independent of key insertion order', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), fc.nat(), (object, seed) => {
        expect(canonicalJson(shuffleKeys(object, seed))).toBe(canonicalJson(object));
      }),
      FC_OPTIONS,
    );
  });

  it('the hash ignores key order and transport metadata', () => {
    fc.assert(
      fc.property(businessFields, fc.nat(), fc.string(), (fields, seed, correlationId) => {
        const reordered = { ...shuffleKeys(fields, seed), correlationId, idempotencyKey: 'any' };
        expect(computeWagerPayloadHash(reordered)).toBe(computeWagerPayloadHash(fields));
      }),
      FC_OPTIONS,
    );
  });

  it('any change to a business field changes the hash', () => {
    fc.assert(
      fc.property(
        businessFields,
        fc.constantFrom('providerId', 'externalTransactionId', 'playerId', 'roundId', 'gameId'),
        (fields, field) => {
          const changed = { ...fields, [field]: `${fields[field]}x` };
          expect(computeWagerPayloadHash(changed)).not.toBe(computeWagerPayloadHash(fields));
        },
      ),
      FC_OPTIONS,
    );
  });
});

describe('ledger cursor properties', () => {
  it('round-trips any sequence number', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 2n ** 63n - 1n }), (sequence) => {
        expect(decodeLedgerCursor(encodeLedgerCursor(String(sequence)))).toBe(String(sequence));
      }),
      FC_OPTIONS,
    );
  });

  it('never accepts arbitrary strings as cursors', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        let decoded: string | undefined;
        try {
          decoded = decodeLedgerCursor(value);
        } catch {
          return;
        }
        expect(decoded).toMatch(/^\d+$/);
      }),
      FC_OPTIONS,
    );
  });
});

describe('outbox retry properties', () => {
  it('backoff is non-decreasing, always in the future and capped at 60s', () => {
    const { wallet } = Wallet.open({
      id: 'w',
      playerId: 'p',
      initialBalance: brl(10_000n),
      openingTransactionId: 't0',
      openingEntryId: 'e0',
      at: new Date(0),
    });
    const entry = wallet.debit({
      transactionId: 't1',
      entryId: 'e1',
      money: brl(100n),
      at: new Date(0),
    });
    const event = WalletBalanceChanged.from(wallet, entry, {
      eventId: 'ev',
      correlationId: 'c',
      occurredAt: new Date(0),
    });

    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 40 }),
        fc.integer({ min: 0, max: 1e12 }),
        (failures, start) => {
          const message = OutboxMessage.enqueue(event);
          let previousDelay = 0;
          for (let i = 0; i < failures; i++) {
            const now = new Date(start);
            message.scheduleRetry(now, 'boom');
            const delay = message.nextAttemptAt.getTime() - now.getTime();
            expect(delay).toBeGreaterThan(0);
            expect(delay).toBeGreaterThanOrEqual(previousDelay);
            expect(delay).toBeLessThanOrEqual(60_000);
            previousDelay = delay;
          }
          expect(message.attempts).toBe(failures);
          expect(message.isPending()).toBe(true);
        },
      ),
      FC_OPTIONS,
    );
  });
});
