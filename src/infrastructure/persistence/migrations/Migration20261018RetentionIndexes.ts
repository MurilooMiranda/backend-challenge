import { Migration } from '@mikro-orm/migrations';

export class Migration20261018RetentionIndexes extends Migration {
  override up(): void {
    this.addSql(`
      CREATE INDEX outbox_published_at_idx
        ON outbox_messages (published_at)
        WHERE published_at IS NOT NULL;
    `);
    this.addSql(`
      CREATE INDEX inbox_processed_at_idx
        ON inbox_messages (processed_at)
        WHERE processed_at IS NOT NULL;
    `);
  }

  override down(): void {
    this.addSql('DROP INDEX IF EXISTS inbox_processed_at_idx;');
    this.addSql('DROP INDEX IF EXISTS outbox_published_at_idx;');
  }
}
