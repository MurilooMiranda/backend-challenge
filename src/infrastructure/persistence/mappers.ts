import { type LedgerDirection, WalletLedgerEntry } from '@/domain/ledger/wallet-ledger-entry';
import type { OutboxMessage } from '@/domain/messaging/outbox-message';
import { Money } from '@/domain/money/money';
import type { FailureCode } from '@/domain/wagering/failure-code';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '@/domain/wagering/wager-transaction';
import { Wallet } from '@/domain/wallet/wallet';
import type {
  LedgerEntryRecord,
  OutboxRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './records';

export function walletToDomain(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: Money.from({ amount: record.balance, currency: record.currency }),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function walletToRecordData(wallet: Wallet): WalletRecord {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toJSON().amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

export function applyWalletToRecord(wallet: Wallet, record: WalletRecord): void {
  record.balance = wallet.balance.toJSON().amount;
  record.version = wallet.version;
  record.updatedAt = wallet.updatedAt;
}

export function transactionToDomain(record: WagerTransactionRecord): WagerTransaction {
  const money = (amount: string) => Money.from({ amount, currency: record.currency });
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind as WagerTransactionKind,
    money: money(record.amount),
    ...(record.referenceExternalTransactionId != null
      ? { referenceExternalTransactionId: record.referenceExternalTransactionId }
      : {}),
    createdAt: record.createdAt,
    status: record.status as WagerTransactionStatus,
    ...(record.referenceTransactionId != null
      ? { referenceTransactionId: record.referenceTransactionId }
      : {}),
    ...(record.failureCode != null ? { failureCode: record.failureCode as FailureCode } : {}),
    ...(record.processedAt != null ? { processedAt: record.processedAt } : {}),
    ...(record.resultingBalance != null
      ? { resultingBalance: money(record.resultingBalance) }
      : {}),
    referenceAttempts: record.referenceAttempts,
    ...(record.nextReferenceCheckAt != null
      ? { nextReferenceCheckAt: record.nextReferenceCheckAt }
      : {}),
  });
}

export function transactionToRecordData(tx: WagerTransaction): WagerTransactionRecord {
  const money = tx.money.toJSON();
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    payloadHash: tx.payloadHash,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    amount: money.amount,
    currency: money.currency,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    resultingBalance: tx.resultingBalance?.toJSON().amount ?? null,
    referenceAttempts: tx.referenceAttempts,
    nextReferenceCheckAt: tx.nextReferenceCheckAt ?? null,
    processedAt: tx.processedAt ?? null,
    createdAt: tx.createdAt,
  };
}

export function ledgerEntryToDomain(record: LedgerEntryRecord): WalletLedgerEntry {
  const money = (amount: string) => Money.from({ amount, currency: record.currency });
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    direction: record.direction as LedgerDirection,
    money: money(record.amount),
    balanceBefore: money(record.balanceBefore),
    balanceAfter: money(record.balanceAfter),
    createdAt: record.createdAt,
  });
}

export function ledgerEntryToRecordData(entry: WalletLedgerEntry): LedgerEntryRecord {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.toJSON().amount,
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.toJSON().amount,
    balanceAfter: entry.balanceAfter.toJSON().amount,
    createdAt: entry.createdAt,
  };
}

export function outboxToRecordData(message: OutboxMessage): OutboxRecord {
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    payload: { ...message.payload },
    occurredAt: message.occurredAt,
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt,
    publishedAt: message.publishedAt ?? null,
    lastError: message.lastError ?? null,
  };
}
