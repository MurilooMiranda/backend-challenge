import { Inject, Injectable, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from './mikro-orm.config';

export const MIKRO_ORM = Symbol('MikroORM');

export const ormProvider: Provider = {
  provide: MIKRO_ORM,
  useFactory: async (): Promise<MikroORM> => {
    const orm = await MikroORM.init(createOrmConfig());
    if (process.env.RUN_MIGRATIONS === 'true') {
      await orm.migrator.up();
    }
    return orm;
  },
};

@Injectable()
export class OrmShutdown implements OnApplicationShutdown {
  constructor(@Inject(MIKRO_ORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}
