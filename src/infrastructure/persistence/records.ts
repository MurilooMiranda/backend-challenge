import { EntitySchema } from '@mikro-orm/core';

const money = { type: 'decimal', precision: 20, scale: 2 } as const;
const nullableMoney = { ...money, nullable: true } as const;
const currency = { type: 'string', columnType: 'char(3)' } as const;
const timestamp = { type: 'datetime', columnType: 'timestamptz' } as const;
const nullableTimestamp = { ...timestamp, nullable: true } as const;
const text = { type: 'text' } as const;
const nullableText = { type: 'text', nullable: true } as const;
const sequence = { type: 'bigint', persist: false, nullable: true } as const;

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: text,
    currency,
    balance: money,
    version: { type: 'integer' },
    createdAt: timestamp,
    updatedAt: timestamp,
  },
});

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status!: string;
  failureCode?: string | null;
  resultingBalance?: string | null;
  referenceAttempts!: number;
  nextReferenceCheckAt?: Date | null;
  processedAt?: Date | null;
  createdAt!: Date;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: text,
    externalTransactionId: text,
    idempotencyKey: text,
    payloadHash: text,
    walletId: { type: 'uuid' },
    playerId: text,
    roundId: text,
    gameId: text,
    kind: text,
    amount: money,
    currency,
    referenceExternalTransactionId: nullableText,
    referenceTransactionId: { type: 'uuid', nullable: true },
    status: text,
    failureCode: nullableText,
    resultingBalance: nullableMoney,
    referenceAttempts: { type: 'integer' },
    nextReferenceCheckAt: nullableTimestamp,
    processedAt: nullableTimestamp,
    createdAt: timestamp,
  },
});

export class LedgerEntryRecord {
  id!: string;
  sequence?: bigint;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    sequence,
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    direction: text,
    amount: money,
    currency,
    balanceBefore: money,
    balanceAfter: money,
    createdAt: timestamp,
  },
});

export class InboxRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
}

export const InboxSchema = new EntitySchema<InboxRecord>({
  class: InboxRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'text', primary: true },
    messageId: { type: 'text', primary: true },
    payloadHash: text,
    receivedAt: timestamp,
    processedAt: nullableTimestamp,
  },
});

export class OutboxRecord {
  id!: string;
  sequence?: bigint;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date;
  publishedAt?: Date | null;
  lastError?: string | null;
  headers!: Record<string, string>;
}

export const OutboxSchema = new EntitySchema<OutboxRecord>({
  class: OutboxRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    sequence,
    aggregateId: text,
    eventType: text,
    payload: { type: 'json' },
    occurredAt: timestamp,
    attempts: { type: 'integer' },
    nextAttemptAt: timestamp,
    publishedAt: nullableTimestamp,
    lastError: nullableText,
    headers: { type: 'json' },
  },
});

export class JournalEntryRecord {
  id!: string;
  transactionId!: string;
  currency!: string;
  createdAt!: Date;
}

export const JournalEntrySchema = new EntitySchema<JournalEntryRecord>({
  class: JournalEntryRecord,
  tableName: 'journal_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    transactionId: { type: 'uuid' },
    currency,
    createdAt: timestamp,
  },
});

export class JournalPostingRecord {
  id!: string;
  journalEntryId!: string;
  accountCode!: string;
  direction!: string;
  amount!: string;
  currency!: string;
}

export const JournalPostingSchema = new EntitySchema<JournalPostingRecord>({
  class: JournalPostingRecord,
  tableName: 'journal_postings',
  properties: {
    id: { type: 'uuid', primary: true },
    journalEntryId: { type: 'uuid' },
    accountCode: text,
    direction: text,
    amount: money,
    currency,
  },
});

export const entities = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  InboxSchema,
  OutboxSchema,
  JournalEntrySchema,
  JournalPostingSchema,
];
