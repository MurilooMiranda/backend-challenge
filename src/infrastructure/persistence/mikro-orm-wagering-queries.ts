import type { MikroORM } from '@mikro-orm/postgresql';
import type {
  LedgerPageRow,
  PendingReferenceRef,
  ReconciliationSnapshot,
  WageringQueries,
} from '@/application/ports';
import { Money } from '@/domain/money/money';
import { WagerTransactionStatus } from '@/domain/wagering/wager-transaction';
import type { WagerTransaction } from '@/domain/wagering/wager-transaction';
import type { Wallet } from '@/domain/wallet/wallet';
import { ledgerEntryToDomain, transactionToDomain, walletToDomain } from './mappers';
import { translatePersistenceError } from './mikro-orm-transaction-runner';
import { LedgerEntryRecord, WagerTransactionRecord, WalletRecord } from './records';

interface ReconciliationRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
  credits: string;
  debits: string;
  entries: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class MikroOrmWageringQueries implements WageringQueries {
  constructor(private readonly orm: MikroORM) {}

  async findWallet(walletId: string): Promise<Wallet | null> {
    if (!UUID_PATTERN.test(walletId)) {
      return null;
    }
    const record = await this.query(() =>
      this.orm.em.fork().findOne(WalletRecord, { id: walletId }),
    );
    return record ? walletToDomain(record) : null;
  }

  async findTransaction(transactionId: string): Promise<WagerTransaction | null> {
    if (!UUID_PATTERN.test(transactionId)) {
      return null;
    }
    const record = await this.query(() =>
      this.orm.em.fork().findOne(WagerTransactionRecord, { id: transactionId }),
    );
    return record ? transactionToDomain(record) : null;
  }

  async findTransactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const record = await this.query(() =>
      this.orm.em.fork().findOne(WagerTransactionRecord, { providerId, externalTransactionId }),
    );
    return record ? transactionToDomain(record) : null;
  }

  async findDuePendingReferences(now: Date, limit: number): Promise<PendingReferenceRef[]> {
    const records = await this.query(() =>
      this.orm.em.fork().find(
        WagerTransactionRecord,
        {
          status: WagerTransactionStatus.PendingReference,
          nextReferenceCheckAt: { $lte: now },
        },
        { orderBy: { nextReferenceCheckAt: 'asc' }, limit, fields: ['id', 'walletId'] },
      ),
    );
    return records.map((record) => ({ transactionId: record.id, walletId: record.walletId }));
  }

  async findLedgerPage(
    walletId: string,
    afterSequence: string | null,
    limit: number,
  ): Promise<LedgerPageRow[]> {
    const records = await this.query(() =>
      this.orm.em.fork().find(
        LedgerEntryRecord,
        {
          walletId,
          ...(afterSequence !== null ? { sequence: { $gt: BigInt(afterSequence) } } : {}),
        },
        { orderBy: { sequence: 'asc' }, limit },
      ),
    );
    return records.map((record) => ({
      sequence: String(record.sequence),
      entry: ledgerEntryToDomain(record),
    }));
  }

  async reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | null> {
    if (!UUID_PATTERN.test(walletId)) {
      return null;
    }
    const [row] = await this.query(() =>
      this.orm.em.fork().execute<ReconciliationRow[]>(
        `SELECT w.id, w.player_id, w.currency, w.balance, w.version, w.created_at, w.updated_at,
                COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 'CREDIT'), 0)::numeric(20, 2) AS credits,
                COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 'DEBIT'), 0)::numeric(20, 2) AS debits,
                count(e.id)::int AS entries
           FROM wallets w
           LEFT JOIN wallet_ledger_entries e ON e.wallet_id = w.id
          WHERE w.id = ?
          GROUP BY w.id`,
        [walletId],
      ),
    );
    if (!row) {
      return null;
    }
    const money = (amount: string) => Money.from({ amount, currency: row.currency });
    return {
      wallet: walletToDomain({
        id: row.id,
        playerId: row.player_id,
        currency: row.currency,
        balance: row.balance,
        version: row.version,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      }),
      credits: money(row.credits),
      debits: money(row.debits),
      entries: row.entries,
    };
  }

  private async query<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw translatePersistenceError(error);
    }
  }
}
