export type Channel = 'http' | 'sqs' | 'worker';

export type ConsumeOutcome = 'acked' | 'dead-lettered' | 'retry';

export interface TransactionSettledEvent {
  channel: Channel;
  transactionId: string;
  walletId: string;
  providerId: string;
  kind: string;
  status: string;
  failureCode: string | null;
  idempotentReplay: boolean;
  durationSeconds: number;
}

export interface ReconciliationCheckedEvent {
  walletId: string;
  consistent: boolean;
  difference: string;
  checkedEntries: number;
}

export interface MessageConsumedEvent {
  messageId: string;
  outcome: ConsumeOutcome;
  failureCode?: string;
}

export interface ReconciliationScanEvent {
  checked: number;
  divergent: number;
  durationSeconds: number;
}

export interface Telemetry {
  transactionSettled(event: TransactionSettledEvent): void;
  lockConflict(reason: string): void;
  walletLockWait(seconds: number): void;
  reconciliationChecked(event: ReconciliationCheckedEvent): void;
  outboxPublished(published: number, failed: number): void;
  messageConsumed(event: MessageConsumedEvent): void;
  reconciliationScanCompleted(event: ReconciliationScanEvent): void;
  messagesPurged(table: 'outbox' | 'inbox', count: number): void;
}

export const TELEMETRY = Symbol('Telemetry');

export const noopTelemetry: Telemetry = {
  transactionSettled: () => undefined,
  lockConflict: () => undefined,
  walletLockWait: () => undefined,
  reconciliationChecked: () => undefined,
  outboxPublished: () => undefined,
  messageConsumed: () => undefined,
  reconciliationScanCompleted: () => undefined,
  messagesPurged: () => undefined,
};
