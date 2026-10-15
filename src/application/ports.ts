import type { WalletLedgerEntry } from '@/domain/ledger/wallet-ledger-entry';
import type { InboxMessage } from '@/domain/messaging/inbox-message';
import type { OutboxMessage } from '@/domain/messaging/outbox-message';
import type { WagerTransaction } from '@/domain/wagering/wager-transaction';
import type { Wallet } from '@/domain/wallet/wallet';

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export interface WageringUnitOfWork {
  lockWallet(walletId: string): Promise<Wallet | null>;
  findExistingTransactions(
    idempotencyKey: string,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction[]>;
  findTransactionById(transactionId: string): Promise<WagerTransaction | null>;
  findTransactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  findInboxMessage(consumerName: string, messageId: string): Promise<InboxMessage | null>;
  addWallet(wallet: Wallet): void;
  saveWallet(wallet: Wallet): void;
  addTransaction(tx: WagerTransaction): void;
  saveTransaction(tx: WagerTransaction): void;
  addLedgerEntry(entry: WalletLedgerEntry): void;
  addOutboxMessages(messages: OutboxMessage[]): void;
  addInboxMessage(message: InboxMessage): void;
}

export interface TransactionRunner {
  run<T>(work: (uow: WageringUnitOfWork) => Promise<T>): Promise<T>;
}

export interface WageringQueries {
  findWallet(walletId: string): Promise<Wallet | null>;
  findTransaction(transactionId: string): Promise<WagerTransaction | null>;
  findTransactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;
  findDuePendingReferences(now: Date, limit: number): Promise<PendingReferenceRef[]>;
}

export interface PendingReferenceRef {
  transactionId: string;
  walletId: string;
}

export interface OutboxStore {
  processDueBatch(
    limit: number,
    now: Date,
    handler: (messages: OutboxMessage[]) => Promise<void>,
  ): Promise<OutboxMessage[]>;
}

export interface EventPublisher {
  publish(message: OutboxMessage): Promise<void>;
}

export const CLOCK = Symbol('Clock');
export const ID_GENERATOR = Symbol('IdGenerator');
export const TRANSACTION_RUNNER = Symbol('TransactionRunner');
export const WAGERING_QUERIES = Symbol('WageringQueries');
export const OUTBOX_STORE = Symbol('OutboxStore');
export const EVENT_PUBLISHER = Symbol('EventPublisher');
