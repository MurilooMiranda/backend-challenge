export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidCommandError extends ApplicationError {
  readonly code = 'INVALID_COMMAND';

  constructor(reason: string) {
    super(`Invalid command: ${reason}`);
  }
}

export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor(idempotencyKey: string) {
    super(`Idempotency key "${idempotencyKey}" was already used with a different payload`);
  }
}

export class InboxPayloadMismatchError extends ApplicationError {
  readonly code = 'INBOX_PAYLOAD_MISMATCH';

  constructor(consumerName: string, messageId: string) {
    super(`Message ${messageId} was already consumed by ${consumerName} with a different payload`);
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';

  constructor(walletId: string) {
    super(`Wallet ${walletId} not found`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`Player ${playerId} already has a ${currency} wallet`);
  }
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = 'TRANSACTION_NOT_FOUND';

  constructor(reference: string) {
    super(`Transaction ${reference} not found`);
  }
}

export class UniqueViolationError extends ApplicationError {
  readonly code = 'UNIQUE_VIOLATION';

  constructor(readonly constraint: string | undefined) {
    super(`Unique constraint violated: ${constraint ?? 'unknown'}`);
  }
}

export class InfrastructureUnavailableError extends ApplicationError {
  readonly code = 'INFRASTRUCTURE_UNAVAILABLE';

  constructor(reason: string) {
    super(`Infrastructure unavailable: ${reason}`);
  }
}
