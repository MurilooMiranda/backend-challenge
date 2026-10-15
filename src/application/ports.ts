import type { WalletLedgerEntry } from '@/domain/ledger/wallet-ledger-entry';
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
  findTransactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  addWallet(wallet: Wallet): void;
  saveWallet(wallet: Wallet): void;
  addTransaction(tx: WagerTransaction): void;
  addLedgerEntry(entry: WalletLedgerEntry): void;
  addOutboxMessages(messages: OutboxMessage[]): void;
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
}

export const CLOCK = Symbol('Clock');
export const ID_GENERATOR = Symbol('IdGenerator');
export const TRANSACTION_RUNNER = Symbol('TransactionRunner');
export const WAGERING_QUERIES = Symbol('WageringQueries');
