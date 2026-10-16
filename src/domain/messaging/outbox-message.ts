import type { IntegrationEvent } from '../events/integration-event';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt?: Date;
  lastError?: string;
  headers?: Readonly<Record<string, string>>;
}

const BASE_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;

export class OutboxMessage {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly headers: Readonly<Record<string, string>>;

  private _attempts: number;
  private _nextAttemptAt: Date;
  private _publishedAt: Date | undefined;
  private _lastError: string | undefined;

  private constructor(state: OutboxMessageState) {
    this.id = state.id;
    this.aggregateId = state.aggregateId;
    this.eventType = state.eventType;
    this.payload = state.payload;
    this.occurredAt = state.occurredAt;
    this.headers = Object.freeze({ ...(state.headers ?? {}) });
    this._attempts = state.attempts;
    this._nextAttemptAt = state.nextAttemptAt;
    this._publishedAt = state.publishedAt;
    this._lastError = state.lastError;
  }

  withHeaders(headers: Readonly<Record<string, string>>): OutboxMessage {
    return new OutboxMessage({
      id: this.id,
      aggregateId: this.aggregateId,
      eventType: this.eventType,
      payload: this.payload,
      occurredAt: this.occurredAt,
      attempts: this._attempts,
      nextAttemptAt: this._nextAttemptAt,
      ...(this._publishedAt ? { publishedAt: this._publishedAt } : {}),
      ...(this._lastError !== undefined ? { lastError: this._lastError } : {}),
      headers: { ...this.headers, ...headers },
    });
  }

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: Object.freeze({ ...event.toJSON() }),
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: event.occurredAt,
    });
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(state);
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      return;
    }
    this._publishedAt = at;
    this._lastError = undefined;
  }

  scheduleRetry(now: Date, error?: string): void {
    this._attempts += 1;
    const delay = Math.min(BASE_RETRY_DELAY_MS * 2 ** (this._attempts - 1), MAX_RETRY_DELAY_MS);
    this._nextAttemptAt = new Date(now.getTime() + delay);
    this._lastError = error;
  }
}
