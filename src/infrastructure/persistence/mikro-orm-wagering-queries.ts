import type { MikroORM } from '@mikro-orm/postgresql';
import type { PendingReferenceRef, WageringQueries } from '@/application/ports';
import { WagerTransactionStatus } from '@/domain/wagering/wager-transaction';
import type { WagerTransaction } from '@/domain/wagering/wager-transaction';
import type { Wallet } from '@/domain/wallet/wallet';
import { transactionToDomain, walletToDomain } from './mappers';
import { translatePersistenceError } from './mikro-orm-transaction-runner';
import { WagerTransactionRecord, WalletRecord } from './records';

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

  private async query<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw translatePersistenceError(error);
    }
  }
}
