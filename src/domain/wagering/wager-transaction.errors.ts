import { DomainError } from '../shared/domain-error';

export class InvalidWagerTransactionError extends DomainError {
  readonly code = 'INVALID_WAGER_TRANSACTION';

  constructor(reason: string) {
    super(`Invalid wager transaction: ${reason}`);
  }
}

export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';

  constructor(transactionId: string, status: string, action: string) {
    super(`Cannot ${action} transaction ${transactionId} in status ${status}`);
  }
}
