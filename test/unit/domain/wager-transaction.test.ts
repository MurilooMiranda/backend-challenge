import { describe, expect, it } from 'bun:test';
import { LedgerDirection } from '@/domain/ledger/wallet-ledger-entry';
import { Money } from '@/domain/money/money';
import { FailureCode } from '@/domain/wagering/failure-code';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '@/domain/wagering/wager-transaction';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from '@/domain/wagering/wager-transaction.errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00.000Z');

const props = (
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps => ({
  id: 'tx-1',
  providerId: 'provider-a',
  externalTransactionId: 'ext-1',
  idempotencyKey: 'provider-a:ext-1',
  payloadHash: 'hash-1',
  walletId: 'wallet-1',
  playerId: 'player-1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: Kind.Bet,
  money: brl('25.00'),
  createdAt: at,
  ...overrides,
});

describe('WagerTransaction', () => {
  describe('create', () => {
    it('starts PENDING with no failure and no attempts', () => {
      const tx = WagerTransaction.create(props());
      expect(tx.status).toBe(Status.Pending);
      expect(tx.isTerminal()).toBe(false);
      expect(tx.failureCode).toBeUndefined();
      expect(tx.referenceAttempts).toBe(0);
    });

    it('rejects OPENING from external input', () => {
      expect(() => WagerTransaction.create(props({ kind: Kind.Opening }))).toThrow(
        InvalidWagerTransactionError,
      );
    });

    it.each([Kind.Refund, Kind.Rollback])('%s requires a reference', (kind) => {
      expect(() => WagerTransaction.create(props({ kind }))).toThrow(InvalidWagerTransactionError);
      expect(() =>
        WagerTransaction.create(props({ kind, referenceExternalTransactionId: '  ' })),
      ).toThrow(InvalidWagerTransactionError);
      expect(
        WagerTransaction.create(props({ kind, referenceExternalTransactionId: 'ext-0' })).status,
      ).toBe(Status.Pending);
    });

    it('rejects zero amount for balance-moving kinds', () => {
      expect(() => WagerTransaction.create(props({ money: brl('0.00') }))).toThrow(
        InvalidWagerTransactionError,
      );
    });

    it('allows zero amount for LOSS', () => {
      const tx = WagerTransaction.create(props({ kind: Kind.Loss, money: brl('0.00') }));
      expect(tx.status).toBe(Status.Pending);
    });

    it.each(['providerId', 'externalTransactionId', 'roundId', 'gameId'] as const)(
      'rejects empty %s',
      (field) => {
        expect(() => WagerTransaction.create(props({ [field]: '' }))).toThrow(
          InvalidWagerTransactionError,
        );
      },
    );
  });

  describe('opening', () => {
    it('is an internal, already processed credit', () => {
      const tx = WagerTransaction.opening({
        id: 'tx-open',
        walletId: 'wallet-1',
        playerId: 'player-1',
        money: brl('100.00'),
        at,
      });
      expect(tx.kind).toBe(Kind.Opening);
      expect(tx.providerId).toBe('internal');
      expect(tx.status).toBe(Status.Processed);
      expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    });
  });

  describe('transitions', () => {
    it('PENDING → PROCESSED records reference, balance and time', () => {
      const tx = WagerTransaction.create(props());
      tx.markProcessed('ref-1', brl('75.00'), at);
      expect(tx.status).toBe(Status.Processed);
      expect(tx.referenceTransactionId).toBe('ref-1');
      expect(tx.resultingBalance?.equals(brl('75.00'))).toBe(true);
      expect(tx.processedAt).toEqual(at);
    });

    it('PENDING → PENDING_REFERENCE increments attempts each time', () => {
      const tx = WagerTransaction.create(
        props({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-0' }),
      );
      tx.markPendingReference(new Date(at.getTime() + 1000));
      tx.markPendingReference(new Date(at.getTime() + 2000));
      expect(tx.status).toBe(Status.PendingReference);
      expect(tx.referenceAttempts).toBe(2);
      expect(tx.nextReferenceCheckAt).toEqual(new Date(at.getTime() + 2000));
    });

    it('PENDING_REFERENCE → PROCESSED clears next check', () => {
      const tx = WagerTransaction.create(
        props({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-0' }),
      );
      tx.markPendingReference(new Date(at.getTime() + 1000));
      tx.markProcessed('ref-1', brl('10.00'), at);
      expect(tx.nextReferenceCheckAt).toBeUndefined();
    });

    it('reject and fail carry a failure code', () => {
      const rejected = WagerTransaction.create(props());
      rejected.reject(FailureCode.InsufficientFunds, brl('10.00'), at);
      expect(rejected.status).toBe(Status.Rejected);
      expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);

      const failed = WagerTransaction.create(props());
      failed.fail(FailureCode.ProcessingFailed, at);
      expect(failed.status).toBe(Status.Failed);
    });

    it.each([
      ['PROCESSED', (tx: WagerTransaction) => tx.markProcessed(undefined, brl('1.00'), at)],
      [
        'REJECTED',
        (tx: WagerTransaction) => tx.reject(FailureCode.InsufficientFunds, undefined, at),
      ],
      ['FAILED', (tx: WagerTransaction) => tx.fail(FailureCode.ProcessingFailed, at)],
    ])('%s is terminal: every further transition throws', (_label, toTerminal) => {
      const tx = WagerTransaction.create(props());
      toTerminal(tx);
      expect(tx.isTerminal()).toBe(true);
      expect(() => tx.markProcessed(undefined, brl('1.00'), at)).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => tx.markPendingReference(at)).toThrow(InvalidTransactionStateError);
      expect(() => tx.reject(FailureCode.InsufficientFunds, undefined, at)).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => tx.fail(FailureCode.ProcessingFailed, at)).toThrow(InvalidTransactionStateError);
    });
  });

  describe('queries', () => {
    it('matchesPayload compares the hash', () => {
      const tx = WagerTransaction.create(props({ payloadHash: 'abc' }));
      expect(tx.matchesPayload('abc')).toBe(true);
      expect(tx.matchesPayload('xyz')).toBe(false);
    });

    it('affectsBalance is false only for LOSS', () => {
      expect(WagerTransaction.create(props({ kind: Kind.Loss })).affectsBalance()).toBe(false);
      expect(WagerTransaction.create(props({ kind: Kind.Win })).affectsBalance()).toBe(true);
    });

    it('ledgerDirectionFor maps kinds and inverts on ROLLBACK', () => {
      const bet = WagerTransaction.create(props({ kind: Kind.Bet }));
      const win = WagerTransaction.create(props({ kind: Kind.Win }));
      const rollback = WagerTransaction.create(
        props({ kind: Kind.Rollback, referenceExternalTransactionId: 'ext-0' }),
      );
      expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
      expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
      expect(WagerTransaction.create(props({ kind: Kind.Loss })).ledgerDirectionFor()).toBeNull();
      expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
      expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    });
  });
});
