import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { migrations } from './migrations';
import { entities } from './records';

export function createOrmConfig(clientUrl = process.env.DATABASE_URL) {
  if (!clientUrl) {
    throw new Error('DATABASE_URL is not set');
  }

  return defineConfig({
    clientUrl,
    entities,
    extensions: [Migrator],
    migrations: {
      migrationsList: migrations,
      snapshot: false,
      silent: true,
    },
    debug: process.env.DB_DEBUG === 'true',
  });
}
