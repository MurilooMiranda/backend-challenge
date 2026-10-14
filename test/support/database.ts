import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from '@/infrastructure/persistence/mikro-orm.config';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering_test';

export async function createTestOrm(): Promise<MikroORM> {
  const orm = await MikroORM.init(createOrmConfig(TEST_DATABASE_URL));
  await orm.migrator.up();
  return orm;
}

export async function resetDatabase(orm: MikroORM): Promise<void> {
  await orm.em.execute(`
    TRUNCATE wallet_ledger_entries, wager_transactions, wallets, inbox_messages, outbox_messages
    RESTART IDENTITY CASCADE
  `);
}

export async function runInTransaction(orm: MikroORM, statements: string[]): Promise<void> {
  await orm.em.fork().transactional(async (em) => {
    for (const sql of statements) {
      await em.execute(sql);
    }
  });
}
