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
  constructor(
    private readonly orm: MikroORM,
    private readonly maxPerAggregate = 20,
  ) {}

  async processDueBatch(
    limit: number,
    now: Date,
    handler: (messages: OutboxMessage[]) => Promise<void>,
  ): Promise<OutboxMessage[]> {
    try {
      // A transação fica aberta durante o envio ao SQS (handler). Se o processo morrer no meio,
      // o rollback solta os locks e outra instância republica: entrega at-least-once.
      return await this.orm.em.fork().transactional(async (em) => {
        // Só a mensagem pendente mais antiga de cada wallet (a "cabeça") pode ser travada aqui.
        // Travar a cabeça reivindica a wallet inteira: outro publisher pula essa linha
        // (SKIP LOCKED) e não enxerga as seguintes como cabeça, então nunca publica um evento
        // posterior antes de um anterior da mesma wallet. Uma cabeça em backoff
        // (next_attempt_at no futuro) segura a fila da wallet pelo mesmo motivo.
        const heads = await em.execute<{ aggregate_id: string }[]>(
          `SELECT o.aggregate_id
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
        if (heads.length === 0) {
          return [];
        }

        // Leva junto as próximas mensagens das wallets reivindicadas, em ordem. FOR UPDATE sem
        // SKIP LOCKED é seguro: só quem segura a cabeça chega até elas, e esse alguém somos nós.
        const claimed = await em.execute<{ id: string }[]>(
          `SELECT id
             FROM outbox_messages
            WHERE id IN (
              SELECT id
                FROM (
                  SELECT id,
                         row_number() OVER (PARTITION BY aggregate_id ORDER BY sequence) AS position
                    FROM outbox_messages
                   WHERE published_at IS NULL
                     AND aggregate_id IN (?)
                ) ranked
               WHERE position <= ?
            )
            FOR UPDATE`,
          [heads.map((head) => head.aggregate_id), this.maxPerAggregate],
        );

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
