import { describe, expect, it } from 'bun:test';
import fc from 'fast-check';
import { JournalEntry } from '@/domain/ledger/journal-entry';
import { LedgerAccount } from '@/domain/ledger/ledger-account';
import { LedgerDirection, type WalletLedgerEntry } from '@/domain/ledger/wallet-ledger-entry';
import { Money } from '@/domain/money/money';
import { ReferenceRetryPolicy } from '@/domain/wagering/reference-retry-policy';
import { WagerSettlement } from '@/domain/wagering/wager-settlement';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '@/domain/wagering/wager-transaction';
import { Wallet } from '@/domain/wallet/wallet';

const NUM_RUNS = Number(process.env.FC_NUM_RUNS ?? 300);
const FC_OPTIONS = {
  numRuns: NUM_RUNS,
  ...(process.env.FC_SEED ? { seed: Number(process.env.FC_SEED) } : {}),
};
const at = new Date('2026-01-01T00:00:00.000Z');
const policy = new ReferenceRetryPolicy(1_000, 1_000, 60_000);

const cents = (value: number) =>
  `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;
const money = (value: number, currency = 'BRL') => Money.from({ amount: cents(value), currency });

interface Operation {
  kind: Kind;
  amount: number;
  target: number;
  matchReferenceAmount: boolean;
  wrongCurrency: boolean;
  missingReference: boolean;
}

const operation: fc.Arbitrary<Operation> = fc.record({
  kind: fc.oneof(
    { weight: 5, arbitrary: fc.constant(Kind.Bet) },
    { weight: 3, arbitrary: fc.constant(Kind.Win) },
    { weight: 1, arbitrary: fc.constant(Kind.Loss) },
    { weight: 2, arbitrary: fc.constant(Kind.Refund) },
    { weight: 2, arbitrary: fc.constant(Kind.Rollback) },
  ),
  amount: fc.integer({ min: 1, max: 60_000 }),
  target: fc.nat(),
  matchReferenceAmount: fc.integer({ min: 0, max: 9 }).map((n) => n < 8),
  wrongCurrency: fc.integer({ min: 0, max: 9 }).map((n) => n === 0),
  missingReference: fc.integer({ min: 0, max: 9 }).map((n) => n < 2),
});

function replay(entries: WalletLedgerEntry[]): Money {
  return entries.reduce(
    (balance, entry) =>
      entry.direction === LedgerDirection.Credit
        ? balance.add(entry.money)
        : balance.subtract(entry.money),
    Money.zero('BRL'),
  );
}

function run(initialCents: number, operations: Operation[]) {
  const { wallet, openingEntry } = Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: money(initialCents),
    openingTransactionId: 'tx-opening',
    openingEntryId: 'entry-opening',
    at,
  });
  const entries: WalletLedgerEntry[] = openingEntry ? [openingEntry] : [];
  const journals: JournalEntry[] = openingEntry
    ? [
        JournalEntry.forWalletMovement({
          id: 'journal-opening',
          entry: openingEntry,
          playerAccount: LedgerAccount.playerWallet(wallet.id, 'BRL'),
          counterparty: LedgerAccount.funding('BRL'),
        }),
      ]
    : [];
  const transactions: WagerTransaction[] = [];
  const reversalsByReference = new Map<string, number>();

  operations.forEach((op, index) => {
    const reversal = op.kind === Kind.Refund || op.kind === Kind.Rollback;
    const reference =
      reversal && !op.missingReference && transactions.length > 0
        ? transactions[op.target % transactions.length]
        : undefined;
    const amount =
      reversal && reference && op.matchReferenceAmount && reference.money.isPositive()
        ? reference.money
        : op.kind === Kind.Loss
          ? money(op.amount - 1)
          : money(op.amount, op.wrongCurrency ? 'USD' : 'BRL');

    const tx = WagerTransaction.create({
      id: `tx-${index}`,
      providerId: 'provider-a',
      externalTransactionId: `ext-${index}`,
      idempotencyKey: `provider-a:ext-${index}`,
      payloadHash: `hash-${index}`,
      walletId: wallet.id,
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: op.kind,
      money: amount,
      ...(reversal
        ? { referenceExternalTransactionId: reference?.externalTransactionId ?? 'missing' }
        : {}),
      createdAt: at,
    });

    const balanceBefore = wallet.balance;
    const versionBefore = wallet.version;
    const { entry } = WagerSettlement.settle(tx, {
      wallet,
      ...(reference ? { reference } : {}),
      referenceAlreadyReversed: reference
        ? (reversalsByReference.get(reference.id) ?? 0) > 0
        : false,
      entryId: `entry-${index}`,
      at,
      retryPolicy: policy,
    });

    expect(wallet.balance.isNegative()).toBe(false);
    expect([Status.Processed, Status.Rejected, Status.PendingReference]).toContain(tx.status);
    if (tx.status === Status.Rejected) {
      expect(tx.failureCode).toBeDefined();
    }

    if (entry) {
      expect(tx.status).toBe(Status.Processed);
      expect(entry.isBalanced()).toBe(true);
      expect(entry.balanceBefore.equals(balanceBefore)).toBe(true);
      expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
      expect(wallet.version).toBe(versionBefore + 1);
      entries.push(entry);
      journals.push(
        JournalEntry.forWalletMovement({
          id: `journal-${index}`,
          entry,
          playerAccount: LedgerAccount.playerWallet(wallet.id, 'BRL'),
          counterparty: LedgerAccount.house('provider-a', 'BRL'),
        }),
      );
    } else {
      expect(wallet.balance.equals(balanceBefore)).toBe(true);
      expect(wallet.version).toBe(versionBefore);
    }

    if (reversal && reference && tx.status === Status.Processed) {
      reversalsByReference.set(reference.id, (reversalsByReference.get(reference.id) ?? 0) + 1);
    }
    transactions.push(tx);
  });

  return { wallet, entries, journals, reversalsByReference, transactions };
}

describe('settlement properties (random operation sequences)', () => {
  it('the balance never goes negative and always equals the ledger replayed from zero', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200_000 }),
        fc.array(operation, { minLength: 5, maxLength: 80, size: 'large' }),
        (initial, operations) => {
          const { wallet, entries } = run(initial, operations);
          expect(replay(entries).equals(wallet.balance)).toBe(true);
          expect(wallet.version).toBe(
            1 + entries.length - (entries[0]?.id === 'entry-opening' ? 1 : 0),
          );
        },
      ),
      FC_OPTIONS,
    );
  });

  it('the ledger is an unbroken chain: each entry starts where the previous one ended', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200_000 }),
        fc.array(operation, { minLength: 5, maxLength: 80, size: 'large' }),
        (initial, operations) => {
          const { entries } = run(initial, operations);
          let previous = Money.zero('BRL');
          for (const entry of entries) {
            expect(entry.balanceBefore.equals(previous)).toBe(true);
            expect(entry.balanceAfter.isNegative()).toBe(false);
            previous = entry.balanceAfter;
          }
        },
      ),
      FC_OPTIONS,
    );
  });

  it('no transaction is ever reversed more than once', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200_000 }),
        fc.array(operation, { minLength: 5, maxLength: 80, size: 'large' }),
        (initial, operations) => {
          const { reversalsByReference } = run(initial, operations);
          for (const count of reversalsByReference.values()) {
            expect(count).toBeLessThanOrEqual(1);
          }
        },
      ),
      FC_OPTIONS,
    );
  });

  it('double-entry books always sum to zero and the player account mirrors the wallet', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200_000 }),
        fc.array(operation, { minLength: 5, maxLength: 80, size: 'large' }),
        (initial, operations) => {
          const { wallet, journals } = run(initial, operations);
          const balances = new Map<string, Money>();
          for (const journal of journals) {
            expect(journal.isBalanced()).toBe(true);
            for (const posting of journal.postings) {
              const current = balances.get(posting.accountCode) ?? Money.zero('BRL');
              balances.set(
                posting.accountCode,
                posting.direction === LedgerDirection.Credit
                  ? current.add(posting.money)
                  : current.subtract(posting.money),
              );
            }
          }
          const total = [...balances.values()].reduce((sum, b) => sum.add(b), Money.zero('BRL'));
          expect(total.isZero()).toBe(true);
          const player = balances.get(`PLAYER:${wallet.id}`) ?? Money.zero('BRL');
          expect(player.equals(wallet.balance)).toBe(true);
        },
      ),
      FC_OPTIONS,
    );
  });

  it('a REFUND and its ROLLBACK of the original never credit the same bet twice', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50_000 }), (betCents) => {
        const { wallet, entries } = run(betCents, [
          {
            kind: Kind.Bet,
            amount: betCents,
            target: 0,
            matchReferenceAmount: true,
            wrongCurrency: false,
            missingReference: false,
          },
          {
            kind: Kind.Refund,
            amount: betCents,
            target: 0,
            matchReferenceAmount: true,
            wrongCurrency: false,
            missingReference: false,
          },
          {
            kind: Kind.Rollback,
            amount: betCents,
            target: 0,
            matchReferenceAmount: true,
            wrongCurrency: false,
            missingReference: false,
          },
          {
            kind: Kind.Refund,
            amount: betCents,
            target: 0,
            matchReferenceAmount: true,
            wrongCurrency: false,
            missingReference: false,
          },
        ]);
        expect(wallet.balance.equals(money(betCents))).toBe(true);
        expect(entries.filter((e) => e.direction === LedgerDirection.Credit)).toHaveLength(2);
      }),
      FC_OPTIONS,
    );
  });
});
