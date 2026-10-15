import { describe, expect, it } from 'bun:test';
import { LedgerDirection } from '@/domain/ledger/wallet-ledger-entry';
import { Money } from '@/domain/money/money';
import { FailureCode } from '@/domain/wagering/failure-code';
import { ReferenceRetryPolicy } from '@/domain/wagering/reference-retry-policy';
import { type SettlementContext, WagerSettlement } from '@/domain/wagering/wager-settlement';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '@/domain/wagering/wager-transaction';
import { InvalidTransactionStateError } from '@/domain/wagering/wager-transaction.errors';
import { Wallet } from '@/domain/wallet/wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00.000Z');
const policy = new ReferenceRetryPolicy(3, 1_000, 60_000);

function openWallet(initial = '100.00') {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initial),
    openingTransactionId: 'tx-open',
    openingEntryId: 'entry-open',
    at,
  }).wallet;
}

let seq = 0;
function tx(kind: Kind, amount = '25.00', overrides: Partial<CreateWagerTransactionProps> = {}) {
  seq += 1;
  return WagerTransaction.create({
    id: `tx-${seq}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${seq}`,
    idempotencyKey: `provider-a:ext-${seq}`,
    payloadHash: `hash-${seq}`,
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl(amount),
    createdAt: at,
    ...overrides,
  });
}

function reversal(kind: Kind.Refund | Kind.Rollback, target: WagerTransaction, amount?: string) {
  return tx(kind, amount ?? target.money.toJSON().amount, {
    referenceExternalTransactionId: target.externalTransactionId,
  });
}

function settle(t: WagerTransaction, wallet: Wallet, extra: Partial<SettlementContext> = {}) {
  return WagerSettlement.settle(t, {
    wallet,
    referenceAlreadyReversed: false,
    entryId: `entry-${t.id}`,
    at,
    retryPolicy: policy,
    ...extra,
  });
}

function processed(kind: Kind, wallet: Wallet, amount = '25.00') {
  const t = tx(kind, amount);
  settle(t, wallet);
  expect(t.status).toBe(Status.Processed);
  return t;
}

describe('WagerSettlement', () => {
  describe('BET', () => {
    it('debits and records the resulting balance', () => {
      const wallet = openWallet('100.00');
      const bet = tx(Kind.Bet, '25.00');
      const { entry } = settle(bet, wallet);

      expect(bet.status).toBe(Status.Processed);
      expect(entry?.direction).toBe(LedgerDirection.Debit);
      expect(wallet.balance.equals(brl('75.00'))).toBe(true);
      expect(bet.resultingBalance?.equals(brl('75.00'))).toBe(true);
    });

    it('is REJECTED with INSUFFICIENT_FUNDS, no entry, balance untouched', () => {
      const wallet = openWallet('20.00');
      const bet = tx(Kind.Bet, '80.00');
      const { entry } = settle(bet, wallet);

      expect(bet.status).toBe(Status.Rejected);
      expect(bet.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(entry).toBeUndefined();
      expect(wallet.balance.equals(brl('20.00'))).toBe(true);
      expect(wallet.version).toBe(1);
      expect(bet.resultingBalance?.equals(brl('20.00'))).toBe(true);
    });
  });

  describe('WIN and LOSS', () => {
    it('WIN credits', () => {
      const wallet = openWallet('100.00');
      const { entry } = settle(tx(Kind.Win, '50.00'), wallet);
      expect(entry?.direction).toBe(LedgerDirection.Credit);
      expect(wallet.balance.equals(brl('150.00'))).toBe(true);
    });

    it('LOSS is processed without moving balance or creating entry', () => {
      const wallet = openWallet('100.00');
      const loss = tx(Kind.Loss, '25.00');
      const { entry } = settle(loss, wallet);
      expect(loss.status).toBe(Status.Processed);
      expect(entry).toBeUndefined();
      expect(wallet.version).toBe(1);
    });
  });

  describe('REFUND', () => {
    it('credits back a processed BET and links the reference', () => {
      const wallet = openWallet('100.00');
      const bet = processed(Kind.Bet, wallet, '25.00');
      const refund = reversal(Kind.Refund, bet);
      const { entry } = settle(refund, wallet, { reference: bet });

      expect(refund.status).toBe(Status.Processed);
      expect(refund.referenceTransactionId).toBe(bet.id);
      expect(entry?.direction).toBe(LedgerDirection.Credit);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    });

    it('cannot reference a WIN', () => {
      const wallet = openWallet();
      const win = processed(Kind.Win, wallet);
      const refund = reversal(Kind.Refund, win);
      settle(refund, wallet, { reference: win });
      expect(refund.failureCode).toBe(FailureCode.InvalidReferenceKind);
    });

    it('must match the reference amount', () => {
      const wallet = openWallet();
      const bet = processed(Kind.Bet, wallet, '25.00');
      const refund = reversal(Kind.Refund, bet, '10.00');
      settle(refund, wallet, { reference: bet });
      expect(refund.failureCode).toBe(FailureCode.ReferenceAmountMismatch);
    });

    it('cannot reverse twice', () => {
      const wallet = openWallet();
      const bet = processed(Kind.Bet, wallet);
      const refund = reversal(Kind.Refund, bet);
      settle(refund, wallet, { reference: bet, referenceAlreadyReversed: true });
      expect(refund.failureCode).toBe(FailureCode.AlreadyReversed);
      expect(wallet.balance.equals(brl('75.00'))).toBe(true);
    });

    it('reference must belong to the same round', () => {
      const wallet = openWallet();
      const bet = processed(Kind.Bet, wallet);
      const refund = tx(Kind.Refund, '25.00', {
        referenceExternalTransactionId: bet.externalTransactionId,
        roundId: 'round-OTHER',
      });
      settle(refund, wallet, { reference: bet });
      expect(refund.failureCode).toBe(FailureCode.ReferenceMismatch);
    });

    it('reference must be PROCESSED', () => {
      const wallet = openWallet('10.00');
      const bet = tx(Kind.Bet, '80.00');
      settle(bet, wallet);
      const refund = reversal(Kind.Refund, bet);
      settle(refund, wallet, { reference: bet });
      expect(refund.failureCode).toBe(FailureCode.ReferenceNotProcessed);
    });
  });

  describe('ROLLBACK', () => {
    it('of a BET credits', () => {
      const wallet = openWallet('100.00');
      const bet = processed(Kind.Bet, wallet, '25.00');
      const rollback = reversal(Kind.Rollback, bet);
      const { entry } = settle(rollback, wallet, { reference: bet });
      expect(entry?.direction).toBe(LedgerDirection.Credit);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    });

    it('of a WIN debits', () => {
      const wallet = openWallet('100.00');
      const win = processed(Kind.Win, wallet, '50.00');
      const rollback = reversal(Kind.Rollback, win);
      const { entry } = settle(rollback, wallet, { reference: win });
      expect(entry?.direction).toBe(LedgerDirection.Debit);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    });

    it('of a WIN without enough balance is REVERSAL_INSUFFICIENT_FUNDS', () => {
      const wallet = openWallet('100.00');
      const win = processed(Kind.Win, wallet, '50.00');
      processed(Kind.Bet, wallet, '120.00');
      const rollback = reversal(Kind.Rollback, win);
      settle(rollback, wallet, { reference: win });

      expect(rollback.status).toBe(Status.Rejected);
      expect(rollback.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
      expect(wallet.balance.equals(brl('30.00'))).toBe(true);
    });

    it('cannot reference a LOSS', () => {
      const wallet = openWallet();
      const loss = processed(Kind.Loss, wallet);
      const rollback = reversal(Kind.Rollback, loss);
      settle(rollback, wallet, { reference: loss });
      expect(rollback.failureCode).toBe(FailureCode.InvalidReferenceKind);
    });
  });

  describe('out-of-order references', () => {
    it('goes PENDING_REFERENCE with exponential backoff, then processes once the reference exists', () => {
      const wallet = openWallet('100.00');
      const bet = tx(Kind.Bet, '25.00');
      const rollback = reversal(Kind.Rollback, bet);

      settle(rollback, wallet);
      expect(rollback.status).toBe(Status.PendingReference);
      expect(rollback.referenceAttempts).toBe(1);
      expect(rollback.nextReferenceCheckAt).toEqual(new Date(at.getTime() + 1_000));

      settle(rollback, wallet);
      expect(rollback.referenceAttempts).toBe(2);
      expect(rollback.nextReferenceCheckAt).toEqual(new Date(at.getTime() + 2_000));

      settle(bet, wallet);
      settle(rollback, wallet, { reference: bet });
      expect(rollback.status).toBe(Status.Processed);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    });

    it('a reference that is itself still pending keeps waiting', () => {
      const wallet = openWallet();
      const pendingBet = tx(Kind.Bet);
      const refund = reversal(Kind.Refund, pendingBet);
      settle(refund, wallet, { reference: pendingBet });
      expect(refund.status).toBe(Status.PendingReference);
    });

    it('is REJECTED with REFERENCE_NOT_FOUND after max attempts', () => {
      const wallet = openWallet();
      const refund = tx(Kind.Refund, '25.00', { referenceExternalTransactionId: 'ghost' });
      for (let i = 0; i < policy.maxAttempts; i++) settle(refund, wallet);
      expect(refund.status).toBe(Status.PendingReference);

      settle(refund, wallet);
      expect(refund.status).toBe(Status.Rejected);
      expect(refund.failureCode).toBe(FailureCode.ReferenceNotFound);
    });
  });

  describe('wallet guards', () => {
    it('rejects a currency different from the wallet', () => {
      const wallet = openWallet();
      const usdBet = tx(Kind.Bet, '1.00', {
        money: Money.from({ amount: '1.00', currency: 'USD' }),
      });
      settle(usdBet, wallet);
      expect(usdBet.failureCode).toBe(FailureCode.CurrencyMismatch);
      expect(usdBet.resultingBalance).toBeUndefined();
      expect(wallet.version).toBe(1);
    });

    it('rejects a wallet owned by another player without exposing its balance', () => {
      const wallet = openWallet();
      const bet = tx(Kind.Bet, '1.00', { playerId: 'player-OTHER' });
      settle(bet, wallet);
      expect(bet.failureCode).toBe(FailureCode.WalletPlayerMismatch);
      expect(bet.resultingBalance).toBeUndefined();
    });

    it('refuses to settle a terminal transaction (programming error)', () => {
      const wallet = openWallet();
      const bet = processed(Kind.Bet, wallet);
      expect(() => settle(bet, wallet)).toThrow(InvalidTransactionStateError);
      expect(wallet.balance.equals(brl('75.00'))).toBe(true);
    });
  });
});
