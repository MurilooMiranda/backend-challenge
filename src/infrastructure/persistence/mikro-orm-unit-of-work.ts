import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { WageringUnitOfWork } from '@/application/ports';
import type { WalletLedgerEntry } from '@/domain/ledger/wallet-ledger-entry';
import type { OutboxMessage } from '@/domain/messaging/outbox-message';
import { WagerTransactionKind, WagerTransactionStatus } from '@/domain/wagering/wager-transaction';
import type { WagerTransaction } from '@/domain/wagering/wager-transaction';
import type { Wallet } from '@/domain/wallet/wallet';
import {
  applyWalletToRecord,
  ledgerEntryToRecordData,
  outboxToRecordData,
  transactionToDomain,
  transactionToRecordData,
  walletToDomain,
  walletToRecordData,
} from './mappers';
import { LedgerEntryRecord, OutboxRecord, WagerTransactionRecord, WalletRecord } from './records';

export class MikroOrmWageringUnitOfWork implements WageringUnitOfWork {
  private readonly lockedWallets = new Map<string, WalletRecord>();

  constructor(private readonly em: EntityManager) {}

  async lockWallet(walletId: string): Promise<Wallet | null> {
    const record = await this.em.findOne(
      WalletRecord,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
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
    const records = await this.em.find(WagerTransactionRecord, {
      $or: [{ idempotencyKey }, { providerId, externalTransactionId }],
    });
    return records.map(transactionToDomain);
  }

  async findTransactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const record = await this.em.findOne(WagerTransactionRecord, {
      providerId,
      externalTransactionId,
    });
    return record ? transactionToDomain(record) : null;
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
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

  addLedgerEntry(entry: WalletLedgerEntry): void {
    this.em.create(LedgerEntryRecord, ledgerEntryToRecordData(entry));
  }

  addOutboxMessages(messages: OutboxMessage[]): void {
    for (const message of messages) {
      this.em.create(OutboxRecord, outboxToRecordData(message));
    }
  }
}
