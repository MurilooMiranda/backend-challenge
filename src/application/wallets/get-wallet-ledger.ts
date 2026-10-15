import type { LedgerDirection } from '@/domain/ledger/wallet-ledger-entry';
import type { MoneyProps } from '@/domain/money/money';
import { InvalidCommandError, WalletNotFoundError } from '../errors';
import type { LedgerPageRow, WageringQueries } from '../ports';

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPage {
  walletId: string;
  entries: LedgerEntryView[];
  nextCursor: string | null;
}

export interface GetWalletLedgerQuery {
  walletId: string;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 200;

export function encodeLedgerCursor(sequence: string): string {
  return Buffer.from(JSON.stringify({ v: 1, s: sequence })).toString('base64url');
}

export function decodeLedgerCursor(cursor: string): string {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      v?: unknown;
      s?: unknown;
    };
    if (parsed.v === 1 && typeof parsed.s === 'string' && /^\d+$/.test(parsed.s)) {
      return parsed.s;
    }
  } catch {
    throw new InvalidCommandError('cursor is invalid');
  }
  throw new InvalidCommandError('cursor is invalid');
}

export class GetWalletLedger {
  constructor(private readonly queries: WageringQueries) {}

  async execute(query: GetWalletLedgerQuery): Promise<LedgerPage> {
    const limit = query.limit ?? DEFAULT_LEDGER_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LEDGER_LIMIT) {
      throw new InvalidCommandError(`limit must be an integer between 1 and ${MAX_LEDGER_LIMIT}`);
    }
    const afterSequence = query.cursor ? decodeLedgerCursor(query.cursor) : null;

    const wallet = await this.queries.findWallet(query.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(query.walletId);
    }

    const rows = await this.queries.findLedgerPage(wallet.id, afterSequence, limit + 1);
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;

    return {
      walletId: wallet.id,
      entries: page.map(toLedgerEntryView),
      nextCursor:
        hasMore && page.length > 0 ? encodeLedgerCursor(page[page.length - 1]!.sequence) : null,
    };
  }
}

function toLedgerEntryView({ entry }: LedgerPageRow): LedgerEntryView {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: entry.createdAt.toISOString(),
  };
}
