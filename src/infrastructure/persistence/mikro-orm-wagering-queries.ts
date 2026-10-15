import { IsolationLevel } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import type {
  LedgerPageRow,
  PendingReferenceRef,
  ReconciliationSnapshot,
  TrialBalanceSnapshot,
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
  journal_credits: string;
  journal_debits: string;
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
                e.credits, e.debits, e.entries, j.journal_credits, j.journal_debits
           FROM wallets w
          CROSS JOIN LATERAL (
            SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0)::numeric(20, 2) AS credits,
                   COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0)::numeric(20, 2) AS debits,
                   count(*)::int AS entries
              FROM wallet_ledger_entries
             WHERE wallet_id = w.id
          ) e
          CROSS JOIN LATERAL (
            SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.direction = 'CREDIT'), 0)::numeric(20, 2) AS journal_credits,
                   COALESCE(SUM(p.amount) FILTER (WHERE p.direction = 'DEBIT'), 0)::numeric(20, 2) AS journal_debits
              FROM journal_postings p
              JOIN ledger_accounts a ON a.code = p.account_code
             WHERE a.wallet_id = w.id
          ) j
          WHERE w.id = ?`,
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
      journalCredits: money(row.journal_credits),
      journalDebits: money(row.journal_debits),
    };
  }

  async trialBalance(currency: string): Promise<TrialBalanceSnapshot> {
    const [accounts, [players], [journals]] = await this.query(() =>
      this.orm.em.fork().transactional(
        async (fork) =>
          [
            await fork.execute<{ code: string; kind: string; credits: string; debits: string }[]>(
              `SELECT a.code, a.kind,
                  COALESCE(SUM(p.amount) FILTER (WHERE p.direction = 'CREDIT'), 0)::numeric(20, 2) AS credits,
                  COALESCE(SUM(p.amount) FILTER (WHERE p.direction = 'DEBIT'), 0)::numeric(20, 2) AS debits
             FROM ledger_accounts a
             LEFT JOIN journal_postings p ON p.account_code = a.code
            WHERE a.currency = ? AND a.kind <> 'PLAYER_WALLET'
            GROUP BY a.code, a.kind
            ORDER BY a.code`,
              [currency],
            ),
            await fork.execute<{ accounts: number; credits: string; debits: string }[]>(
              `SELECT (SELECT count(*)::int FROM ledger_accounts WHERE currency = ? AND kind = 'PLAYER_WALLET') AS accounts,
                  COALESCE(SUM(p.amount) FILTER (WHERE p.direction = 'CREDIT'), 0)::numeric(20, 2) AS credits,
                  COALESCE(SUM(p.amount) FILTER (WHERE p.direction = 'DEBIT'), 0)::numeric(20, 2) AS debits
             FROM journal_postings p
             JOIN ledger_accounts a ON a.code = p.account_code
            WHERE a.currency = ? AND a.kind = 'PLAYER_WALLET'`,
              [currency, currency],
            ),
            await fork.execute<{ entries: number; unbalanced: number }[]>(
              `SELECT count(*)::int AS entries,
                  count(*) FILTER (WHERE debits <> credits)::int AS unbalanced
             FROM (
               SELECT j.id,
                      COALESCE(SUM(p.amount) FILTER (WHERE p.direction = 'DEBIT'), 0) AS debits,
                      COALESCE(SUM(p.amount) FILTER (WHERE p.direction = 'CREDIT'), 0) AS credits
                 FROM journal_entries j
                 LEFT JOIN journal_postings p ON p.journal_entry_id = j.id
                WHERE j.currency = ?
                GROUP BY j.id
             ) totals`,
              [currency],
            ),
          ] as const,
        { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true },
      ),
    );
    const money = (amount: string) => Money.from({ amount, currency });
    return {
      accounts: accounts.map((row) => ({
        code: row.code,
        kind: row.kind,
        credits: money(row.credits),
        debits: money(row.debits),
      })),
      playerWallets: {
        accounts: players?.accounts ?? 0,
        credits: money(players?.credits ?? '0.00'),
        debits: money(players?.debits ?? '0.00'),
      },
      journalEntries: journals?.entries ?? 0,
      unbalancedJournalEntries: journals?.unbalanced ?? 0,
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
