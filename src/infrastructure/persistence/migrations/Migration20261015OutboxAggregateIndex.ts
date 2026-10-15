import { Migration } from '@mikro-orm/migrations';

export class Migration20261015OutboxAggregateIndex extends Migration {
  override up(): void {
    this.addSql(`
      CREATE INDEX outbox_pending_aggregate_idx
        ON outbox_messages (aggregate_id, sequence)
        WHERE published_at IS NULL;
    `);
  }

  override down(): void {
    this.addSql('DROP INDEX IF EXISTS outbox_pending_aggregate_idx;');
  }
}
