import type { MikroORM } from '@mikro-orm/postgresql';
import type { OutboxStore } from '@/application/ports';
import type { OutboxMessage } from '@/domain/messaging/outbox-message';
import { applyOutboxToRecord, outboxToDomain } from './mappers';
import { translatePersistenceError } from './mikro-orm-transaction-runner';
import { OutboxRecord } from './records';

export interface OutboxStats {
  pending: number;
  oldestPendingAgeSeconds: number;
}

export class MikroOrmOutboxStore implements OutboxStore {
  constructor(private readonly orm: MikroORM) {}

  async processDueBatch(
    limit: number,
    now: Date,
    handler: (messages: OutboxMessage[]) => Promise<void>,
  ): Promise<OutboxMessage[]> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        const claimed = await em.execute<{ id: string }[]>(
          `SELECT o.id
             FROM outbox_messages o
            WHERE o.published_at IS NULL
              AND o.next_attempt_at <= ?
              AND NOT EXISTS (
                SELECT 1
                  FROM outbox_messages earlier
                 WHERE earlier.aggregate_id = o.aggregate_id
                   AND earlier.published_at IS NULL
                   AND earlier.sequence < o.sequence
              )
            ORDER BY o.sequence
            LIMIT ?
            FOR UPDATE SKIP LOCKED`,
          [now, limit],
        );
        if (claimed.length === 0) {
          return [];
        }

        const records = await em.find(
          OutboxRecord,
          { id: { $in: claimed.map((row) => row.id) } },
          { orderBy: { sequence: 'asc' } },
        );

        const messages = records.map(outboxToDomain);
        await handler(messages);
        records.forEach((record, index) => applyOutboxToRecord(messages[index]!, record));
        return messages;
      });
    } catch (error) {
      throw translatePersistenceError(error);
    }
  }

  async stats(now: Date): Promise<OutboxStats> {
    const [row] = await this.orm.em.fork().execute<{ pending: number; oldest: Date | null }[]>(
      `SELECT count(*)::int AS pending, min(occurred_at) AS oldest
         FROM outbox_messages
        WHERE published_at IS NULL`,
    );
    const oldest = row?.oldest ? new Date(row.oldest) : null;
    return {
      pending: row?.pending ?? 0,
      oldestPendingAgeSeconds: oldest ? Math.max(0, (now.getTime() - oldest.getTime()) / 1000) : 0,
    };
  }
}
