import type { Clock, EventPublisher, OutboxStore } from '../ports';
import { type Telemetry, noopTelemetry } from '../telemetry';

export interface PublishOutboxEventsResult {
  published: number;
  failed: number;
}

export class PublishOutboxEvents {
  constructor(
    private readonly outbox: OutboxStore,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly telemetry: Telemetry = noopTelemetry,
  ) {}

  async execute(batchSize = 25): Promise<PublishOutboxEventsResult> {
    let published = 0;
    let failed = 0;

    await this.outbox.processDueBatch(batchSize, this.clock.now(), async (messages) => {
      const blockedAggregates = new Set<string>();
      for (const message of messages) {
        if (blockedAggregates.has(message.aggregateId)) {
          continue;
        }
        try {
          await this.publisher.publish(message);
          message.markPublished(this.clock.now());
          published += 1;
        } catch (error) {
          message.scheduleRetry(
            this.clock.now(),
            error instanceof Error ? error.message : String(error),
          );
          blockedAggregates.add(message.aggregateId);
          failed += 1;
        }
      }
    });

    if (published > 0 || failed > 0) {
      this.telemetry.outboxPublished(published, failed);
    }
    return { published, failed };
  }
}
