import { IsolationLevel } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import type {
  MaintenanceStore,
  WalletConsistencyRow,
  WalletConsistencyScan,
} from '@/application/ports';
import { Money } from '@/domain/money/money';
import { translatePersistenceError } from './mikro-orm-transaction-runner';

const RECONCILIATION_LOCK_KEY = 7_316_001;

interface ConsistencyRow {
  id: string;
  currency: string;
  balance: string;
  ledger_credits: string;
  ledger_debits: string;
  journal_credits: string;
  journal_debits: string;
}

export class MikroOrmMaintenanceStore implements MaintenanceStore {
  constructor(private readonly orm: MikroORM) {}

  async purgePublishedOutbox(publishedBefore: Date, limit: number): Promise<number> {
    return this.deleteReturningCount(
      `DELETE FROM outbox_messages
        WHERE id IN (
          SELECT id
            FROM outbox_messages
           WHERE published_at IS NOT NULL AND published_at < ?
           ORDER BY published_at
           LIMIT ?
           FOR UPDATE SKIP LOCKED
        )
       RETURNING 1`,
      [publishedBefore, limit],
    );
  }

  async purgeProcessedInbox(processedBefore: Date, limit: number): Promise<number> {
    return this.deleteReturningCount(
      `DELETE FROM inbox_messages
        WHERE (consumer_name, message_id) IN (
          SELECT consumer_name, message_id
            FROM inbox_messages
           WHERE processed_at IS NOT NULL AND processed_at < ?
           ORDER BY processed_at
           LIMIT ?
           FOR UPDATE SKIP LOCKED
        )
       RETURNING 1`,
      [processedBefore, limit],
    );
  }

  async scanWalletConsistency(batchSize: number): Promise<WalletConsistencyScan | null> {
    try {
      return await this.orm.em.fork().transactional(
        async (em) => {
          const [lock] = await em.execute<{ locked: boolean }[]>(
            'SELECT pg_try_advisory_xact_lock(?) AS locked',
            [RECONCILIATION_LOCK_KEY],
          );
          if (!lock?.locked) {
            return null;
          }

          let checked = 0;
          const divergent: WalletConsistencyRow[] = [];
          let after = '00000000-0000-0000-0000-000000000000';
          for (;;) {
            const rows = await em.execute<ConsistencyRow[]>(
              `SELECT w.id, w.currency, w.balance,
                      l.credits AS ledger_credits, l.debits AS ledger_debits,
                      j.credits AS journal_credits, j.debits AS journal_debits
                 FROM wallets w
                CROSS JOIN LATERAL (
                  SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0)::numeric(20, 2) AS credits,
                         COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0)::numeric(20, 2) AS debits
                    FROM wallet_ledger_entries
                   WHERE wallet_id = w.id
                ) l
                CROSS JOIN LATERAL (
                  SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.direction = 'CREDIT'), 0)::numeric(20, 2) AS credits,
                         COALESCE(SUM(p.amount) FILTER (WHERE p.direction = 'DEBIT'), 0)::numeric(20, 2) AS debits
                    FROM journal_postings p
                    JOIN ledger_accounts a ON a.code = p.account_code
                   WHERE a.wallet_id = w.id
                ) j
                WHERE w.id > ?
                ORDER BY w.id
                LIMIT ?`,
              [after, batchSize],
            );
            for (const row of rows) {
              const money = (amount: string) => Money.from({ amount, currency: row.currency });
              const stored = money(row.balance);
              const ledger = money(row.ledger_credits).subtract(money(row.ledger_debits));
              const journal = money(row.journal_credits).subtract(money(row.journal_debits));
              if (!stored.equals(ledger) || !stored.equals(journal)) {
                divergent.push({ walletId: row.id, stored, ledger, journal });
              }
            }
            checked += rows.length;
            if (rows.length < batchSize) {
              return { checked, divergent };
            }
            after = rows.at(-1)!.id;
          }
        },
        { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true },
      );
    } catch (error) {
      throw translatePersistenceError(error);
    }
  }

  private async deleteReturningCount(sql: string, params: unknown[]): Promise<number> {
    try {
      const rows = await this.orm.em.fork().execute<unknown[]>(sql, params);
      return rows.length;
    } catch (error) {
      throw translatePersistenceError(error);
    }
  }
}
