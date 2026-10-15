import type { OutboxMessage } from '@/domain/messaging/outbox-message';
import type { Clock, EventPublisher, OutboxStore } from '../ports';
import { type Telemetry, noopTelemetry } from '../telemetry';

export interface PublishOutboxEventsResult {
  published: number;
  failed: number;
}

function chunk<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, i * size + size),
  );
}

export class PublishOutboxEvents {
  constructor(
    private readonly outbox: OutboxStore,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly telemetry: Telemetry = noopTelemetry,
  ) {}

  async execute(batchSize = 100): Promise<PublishOutboxEventsResult> {
    let published = 0;
    let failed = 0;

    await this.outbox.processDueBatch(batchSize, this.clock.now(), async (messages) => {
      const result = await this.publishInOrder(messages);
      published += result.published;
      failed += result.failed;
    });

    if (published > 0 || failed > 0) {
      this.telemetry.outboxPublished(published, failed);
    }
    return { published, failed };
  }

  private async publishInOrder(messages: OutboxMessage[]): Promise<PublishOutboxEventsResult> {
    const size = this.publisher.maxBatchSize;
    const chunksByAggregate = new Map<string, OutboxMessage[][]>();
    const ordered = new Map<string, OutboxMessage[]>();
    for (const message of messages) {
      ordered.set(message.aggregateId, [...(ordered.get(message.aggregateId) ?? []), message]);
    }
    for (const [aggregateId, list] of ordered) {
      chunksByAggregate.set(aggregateId, chunk(list, size));
    }

    const blocked = new Set<string>();
    let published = 0;
    let failed = 0;
    const rounds = Math.max(0, ...[...chunksByAggregate.values()].map((chunks) => chunks.length));

    for (let round = 0; round < rounds; round++) {
      const roundChunks = [...chunksByAggregate.entries()]
        .filter(([aggregateId, chunks]) => !blocked.has(aggregateId) && chunks[round])
        .map(([, chunks]) => chunks[round]!);

      const batches: OutboxMessage[][][] = [];
      for (const group of roundChunks) {
        const current = batches.at(-1);
        const used = current?.reduce((sum, items) => sum + items.length, 0) ?? size;
        if (current && used + group.length <= size) {
          current.push(group);
        } else {
          batches.push([group]);
        }
      }

      await Promise.all(
        batches.map(async (groups) => {
          const outcomes = await this.publisher.publishBatch(groups.flat());
          const byId = new Map(outcomes.map((outcome) => [outcome.messageId, outcome]));
          const now = this.clock.now();
          for (const group of groups) {
            for (const message of group) {
              const outcome = byId.get(message.id);
              if (!outcome || outcome.error !== undefined) {
                message.scheduleRetry(now, outcome?.error ?? 'no publish outcome');
                blocked.add(message.aggregateId);
                failed += 1;
                break;
              }
              message.markPublished(now);
              published += 1;
            }
          }
        }),
      );
    }

    return { published, failed };
  }
}
