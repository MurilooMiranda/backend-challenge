import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { WageringUnitOfWork } from '@/application/ports';
import { type Telemetry, noopTelemetry } from '@/application/telemetry';
import type { JournalEntry } from '@/domain/ledger/journal-entry';
import type { LedgerAccount } from '@/domain/ledger/ledger-account';
import type { WalletLedgerEntry } from '@/domain/ledger/wallet-ledger-entry';
import { randomUUIDv7 } from 'bun';
import type { InboxMessage } from '@/domain/messaging/inbox-message';
import type { OutboxMessage } from '@/domain/messaging/outbox-message';
import { WagerTransactionKind, WagerTransactionStatus } from '@/domain/wagering/wager-transaction';
import type { WagerTransaction } from '@/domain/wagering/wager-transaction';
import type { Wallet } from '@/domain/wallet/wallet';
import { SpanKind, injectTraceHeaders, withSpan } from '../observability/tracing';
import {
  applyTransactionToRecord,
  applyWalletToRecord,
  inboxToDomain,
  inboxToRecordData,
  ledgerEntryToRecordData,
  outboxToRecordData,
  transactionToDomain,
  transactionToRecordData,
  walletToDomain,
  walletToRecordData,
} from './mappers';
import {
  InboxRecord,
  JournalEntryRecord,
  JournalPostingRecord,
  LedgerEntryRecord,
  OutboxRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './records';

export class MikroOrmWageringUnitOfWork implements WageringUnitOfWork {
  private readonly lockedWallets = new Map<string, WalletRecord>();
  private readonly loadedTransactions = new Map<string, WagerTransactionRecord>();
  private readonly ensuredAccounts = new Set<string>();

  constructor(
    private readonly em: EntityManager,
    private readonly telemetry: Telemetry = noopTelemetry,
  ) {}

  async lockWallet(walletId: string): Promise<Wallet | null> {
    const startedAt = performance.now();
    const record = await withSpan(
      'wallet.lock',
      { 'wallet.id': walletId, 'db.system': 'postgresql', 'db.operation': 'SELECT FOR UPDATE' },
      () =>
        this.em.findOne(WalletRecord, { id: walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE }),
      { kind: SpanKind.CLIENT },
    );
    this.telemetry.walletLockWait((performance.now() - startedAt) / 1000);
    if (!record) {
      return null;
    }
    this.lockedWallets.set(record.id, record);
    return walletToDomain(record);
  }

  async findExistingTransactions(
    idempotencyKey: string,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction[]> {
    // As duas chaves numa consulta só: em duas consultas separadas, um commit concorrente entre
    // elas fazia uma aparecer e a outra não, e o replay virava um falso conflito.
    const records = await this.em.find(WagerTransactionRecord, {
      $or: [{ idempotencyKey }, { providerId, externalTransactionId }],
    });
    return records.map((record) => this.track(record));
  }

  async findTransactionById(transactionId: string): Promise<WagerTransaction | null> {
    const record = await this.em.findOne(WagerTransactionRecord, { id: transactionId });
    return record ? this.track(record) : null;
  }

  async findTransactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const record = await this.em.findOne(WagerTransactionRecord, {
      providerId,
      externalTransactionId,
    });
    return record ? this.track(record) : null;
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async findInboxMessage(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const record = await this.em.findOne(InboxRecord, { consumerName, messageId });
    return record ? inboxToDomain(record) : null;
  }

  addWallet(wallet: Wallet): void {
    this.em.create(WalletRecord, walletToRecordData(wallet));
  }

  saveWallet(wallet: Wallet): void {
    const record = this.lockedWallets.get(wallet.id);
    if (!record) {
      throw new Error(`Wallet ${wallet.id} must be locked before being saved`);
    }
    applyWalletToRecord(wallet, record);
  }

  addTransaction(tx: WagerTransaction): void {
    this.em.create(WagerTransactionRecord, transactionToRecordData(tx));
  }

  saveTransaction(tx: WagerTransaction): void {
    const record = this.loadedTransactions.get(tx.id);
    if (!record) {
      throw new Error(`Transaction ${tx.id} must be loaded before being saved`);
    }
    applyTransactionToRecord(tx, record);
  }

  addLedgerEntry(entry: WalletLedgerEntry): void {
    this.em.create(LedgerEntryRecord, ledgerEntryToRecordData(entry));
  }

  addOutboxMessages(messages: OutboxMessage[]): void {
    // O traceparent atual vai junto com o evento, na mesma transação, para que a publicação
    // assíncrona (em outra instância, até) continue o trace da requisição que a originou.
    const headers = injectTraceHeaders();
    for (const message of messages) {
      this.em.create(OutboxRecord, outboxToRecordData(message.withHeaders(headers)));
    }
  }

  async ensureAccounts(accounts: LedgerAccount[]): Promise<void> {
    const missing = accounts.filter((account) => !this.ensuredAccounts.has(account.code));
    if (missing.length > 0) {
      // ON CONFLICT sem alvo: a tabela tem mais de uma constraint única (code e wallet_id), e com
      // ON CONFLICT (code) duas transações criando a mesma conta ao mesmo tempo estouravam na outra.
      const placeholders = missing.map(() => '(?, ?, ?, ?, ?)').join(', ');
      await this.em.execute(
        `INSERT INTO ledger_accounts (code, kind, currency, wallet_id, provider_id)
         VALUES ${placeholders}
         ON CONFLICT DO NOTHING`,
        missing.flatMap((account) => [
          account.code,
          account.kind,
          account.currency,
          account.walletId ?? null,
          account.providerId ?? null,
        ]),
      );
      for (const account of missing) {
        this.ensuredAccounts.add(account.code);
      }
    }
  }

  addJournalEntry(journal: JournalEntry): void {
    this.em.create(JournalEntryRecord, {
      id: journal.id,
      transactionId: journal.transactionId,
      currency: journal.currency,
      createdAt: journal.createdAt,
    });
    for (const posting of journal.postings) {
      this.em.create(JournalPostingRecord, {
        id: randomUUIDv7(),
        journalEntryId: journal.id,
        accountCode: posting.accountCode,
        direction: posting.direction,
        amount: posting.money.toJSON().amount,
        currency: posting.money.currency,
      });
    }
  }

  addInboxMessage(message: InboxMessage): void {
    this.em.create(InboxRecord, inboxToRecordData(message));
  }

  private track(record: WagerTransactionRecord): WagerTransaction {
    this.loadedTransactions.set(record.id, record);
    return transactionToDomain(record);
  }
}
