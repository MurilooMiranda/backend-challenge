import { Migration20261014InitialSchema } from './Migration20261014InitialSchema';
import { Migration20261015OutboxAggregateIndex } from './Migration20261015OutboxAggregateIndex';
import { Migration20261016DoubleEntryLedger } from './Migration20261016DoubleEntryLedger';

export const migrations = [
  { name: 'Migration20261014InitialSchema', class: Migration20261014InitialSchema },
  { name: 'Migration20261015OutboxAggregateIndex', class: Migration20261015OutboxAggregateIndex },
  { name: 'Migration20261016DoubleEntryLedger', class: Migration20261016DoubleEntryLedger },
];
