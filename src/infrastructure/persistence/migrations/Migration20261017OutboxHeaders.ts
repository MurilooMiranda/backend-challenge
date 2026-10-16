import { Migration } from '@mikro-orm/migrations';

export class Migration20261017OutboxHeaders extends Migration {
  override up(): void {
    this.addSql(
      `ALTER TABLE outbox_messages ADD COLUMN headers jsonb NOT NULL DEFAULT '{}'::jsonb;`,
    );
  }

  override down(): void {
    this.addSql('ALTER TABLE outbox_messages DROP COLUMN IF EXISTS headers;');
  }
}
