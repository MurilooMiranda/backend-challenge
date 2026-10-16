import type { Clock, MaintenanceStore } from '../ports';
import { type Telemetry, noopTelemetry } from '../telemetry';

export interface RetentionPolicy {
  outboxRetentionMs: number;
  inboxRetentionMs: number;
  batchSize: number;
}

export interface PurgeResult {
  outbox: number;
  inbox: number;
}

const HOUR = 60 * 60 * 1_000;

export function retentionPolicyFromEnv(): RetentionPolicy {
  return {
    outboxRetentionMs: Number(process.env.OUTBOX_RETENTION_HOURS ?? 72) * HOUR,
    inboxRetentionMs: Number(process.env.INBOX_RETENTION_DAYS ?? 7) * 24 * HOUR,
    batchSize: Number(process.env.RETENTION_BATCH_SIZE ?? 1_000),
  };
}

export class PurgeExpiredMessages {
  constructor(
    private readonly store: MaintenanceStore,
    private readonly clock: Clock,
    private readonly policy: RetentionPolicy,
    private readonly telemetry: Telemetry = noopTelemetry,
  ) {}

  async execute(): Promise<PurgeResult> {
    const now = this.clock.now().getTime();
    const outbox = await this.store.purgePublishedOutbox(
      new Date(now - this.policy.outboxRetentionMs),
      this.policy.batchSize,
    );
    const inbox = await this.store.purgeProcessedInbox(
      new Date(now - this.policy.inboxRetentionMs),
      this.policy.batchSize,
    );
    if (outbox > 0) {
      this.telemetry.messagesPurged('outbox', outbox);
    }
    if (inbox > 0) {
      this.telemetry.messagesPurged('inbox', inbox);
    }
    return { outbox, inbox };
  }

  hasMoreWork(result: PurgeResult): boolean {
    return result.outbox === this.policy.batchSize || result.inbox === this.policy.batchSize;
  }
}
