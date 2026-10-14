import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from './mikro-orm.config';

const direction = process.argv[2];
if (direction !== 'up' && direction !== 'down') {
  console.error('usage: bun src/infrastructure/persistence/migrate.ts <up|down>');
  process.exit(1);
}

const orm = await MikroORM.init(createOrmConfig());
try {
  const executed = direction === 'up' ? await orm.migrator.up() : await orm.migrator.down();
  const names = executed.map((m) => m.name);
  console.log(`migrations ${direction}:`, names.length ? names.join(', ') : '(nothing to do)');
} finally {
  await orm.close();
}
