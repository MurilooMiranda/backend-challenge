import { DomainError } from '../shared/domain-error';

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor(public readonly walletId: string) {
    super(`Wallet ${walletId} has insufficient funds`);
  }
}
