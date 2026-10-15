import type { MoneyProps } from '@/domain/money/money';
import type { FailureCode } from '@/domain/wagering/failure-code';
import type { WagerTransaction, WagerTransactionStatus } from '@/domain/wagering/wager-transaction';

export interface WagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps | null;
  failureCode: FailureCode | null;
  idempotentReplay: boolean;
}

export function toWagerTransactionResult(
  tx: WagerTransaction,
  idempotentReplay: boolean,
): WagerTransactionResult {
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: tx.resultingBalance?.toJSON() ?? null,
    failureCode: tx.failureCode ?? null,
    idempotentReplay,
  };
}
