import { Migration20261014InitialSchema } from './Migration20261014InitialSchema';
import { Migration20261015OutboxAggregateIndex } from './Migration20261015OutboxAggregateIndex';

export const migrations = [
  { name: 'Migration20261014InitialSchema', class: Migration20261014InitialSchema },
  { name: 'Migration20261015OutboxAggregateIndex', class: Migration20261015OutboxAggregateIndex },
];
