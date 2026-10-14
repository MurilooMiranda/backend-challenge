import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import type { Wallet } from '../wallet/wallet';
import { InsufficientFundsError } from '../wallet/wallet.errors';
import { FailureCode } from './failure-code';
import { InvalidTransactionStateError } from './wager-transaction.errors';
import type { ReferenceRetryPolicy } from './reference-retry-policy';
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';

export interface SettlementContext {
  wallet: Wallet;
  reference?: WagerTransaction;
  referenceAlreadyReversed: boolean;
  entryId: string;
  at: Date;
  retryPolicy: ReferenceRetryPolicy;
}

export interface SettlementResult {
  entry?: WalletLedgerEntry;
}

const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, WagerTransactionKind[]>> = {
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

export class WagerSettlement {
  static settle(tx: WagerTransaction, ctx: SettlementContext): SettlementResult {
    const { wallet, reference, at } = ctx;

    if (tx.isTerminal()) {
      throw new InvalidTransactionStateError(tx.id, tx.status, 'settle');
    }

    if (wallet.id !== tx.walletId) {
      throw new Error(`Wallet ${wallet.id} does not belong to transaction ${tx.id}`);
    }
    if (wallet.playerId !== tx.playerId) {
      return WagerSettlement.reject(tx, FailureCode.WalletPlayerMismatch, wallet, at);
    }
    if (wallet.currency !== tx.money.currency) {
      return WagerSettlement.reject(tx, FailureCode.CurrencyMismatch, wallet, at);
    }

    if (tx.requiresReference()) {
      if (!reference || !reference.isTerminal()) {
        if (tx.referenceAttempts >= ctx.retryPolicy.maxAttempts) {
          return WagerSettlement.reject(tx, FailureCode.ReferenceNotFound, wallet, at);
        }
        tx.markPendingReference(ctx.retryPolicy.nextCheckAt(tx.referenceAttempts + 1, at));
        return {};
      }

      const problem = WagerSettlement.validateReference(
        tx,
        reference,
        ctx.referenceAlreadyReversed,
      );
      if (problem) {
        return WagerSettlement.reject(tx, problem, wallet, at);
      }
    }

    const direction = tx.ledgerDirectionFor(reference);
    if (direction === null) {
      tx.markProcessed(reference?.id, wallet.balance, at);
      return {};
    }

    const movement = { transactionId: tx.id, entryId: ctx.entryId, money: tx.money, at };
    try {
      const entry =
        direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
      tx.markProcessed(reference?.id, wallet.balance, at);
      return { entry };
    } catch (error) {
      if (!(error instanceof InsufficientFundsError)) throw error;
      const code =
        tx.kind === WagerTransactionKind.Bet
          ? FailureCode.InsufficientFunds
          : FailureCode.ReversalInsufficientFunds;
      return WagerSettlement.reject(tx, code, wallet, at);
    }
  }

  private static validateReference(
    tx: WagerTransaction,
    reference: WagerTransaction,
    alreadyReversed: boolean,
  ): FailureCode | null {
    if (reference.status !== WagerTransactionStatus.Processed) {
      return FailureCode.ReferenceNotProcessed;
    }

    const sameOwner =
      reference.providerId === tx.providerId &&
      reference.playerId === tx.playerId &&
      reference.walletId === tx.walletId &&
      reference.money.currency === tx.money.currency &&
      reference.roundId === tx.roundId;
    if (!sameOwner) {
      return FailureCode.ReferenceMismatch;
    }

    const allowed = ALLOWED_REFERENCE_KINDS[tx.kind] ?? [];
    if (!allowed.includes(reference.kind)) {
      return FailureCode.InvalidReferenceKind;
    }
    if (!reference.money.equals(tx.money)) {
      return FailureCode.ReferenceAmountMismatch;
    }
    if (alreadyReversed) {
      return FailureCode.AlreadyReversed;
    }
    return null;
  }

  private static reject(
    tx: WagerTransaction,
    code: FailureCode,
    wallet: Wallet,
    at: Date,
  ): SettlementResult {
    tx.reject(code, wallet.balance, at);
    return {};
  }
}
