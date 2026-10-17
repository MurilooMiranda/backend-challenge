# 7. MikroORM com EntitySchema e migrations em SQL escrito à mão

Data: 2026-10-14

## Status

Aceito

## Contexto

O domínio não pode depender do ORM ([ADR 0002](0002-ports-and-adapters-with-a-pure-domain.md)), e as invariantes do banco dependem de recursos que geradores de schema não produzem: triggers, constraint triggers deferidas, índices parciais e FKs compostas deferíveis ([ADR 0006](0006-enforce-ledger-invariants-in-the-database.md)). O desafio pede MikroORM.

## Decisão

- MikroORM com `EntitySchema`: classes de record sem decorators, espelho 1:1 das tabelas, convertidas de e para o domínio por mappers explícitos.
- Unit of Work por tentativa: `orm.em.fork().transactional(...)`, identity map limpo e flush único no commit.
- Migrations escritas à mão em SQL, com `up` e `down`, registradas numa lista explícita (`migrationsList`), sem descoberta por glob.
- FKs `DEFERRABLE INITIALLY DEFERRED`, para que o Unit of Work possa ordenar os INSERTs livremente.
- Consultas de leitura e agregação (reconciliação, balancete, outbox) em SQL direto onde o ORM atrapalharia (`FOR UPDATE SKIP LOCKED`, `LATERAL`, advisory locks).

## Alternativas consideradas

- **Entidades do domínio decoradas para o ORM.** Menos código, mas o domínio passaria a carregar metadados e regras de lazy loading do ORM.
- **Migrations geradas pelo ORM.** Não geram os triggers e índices parciais; seriam editadas à mão de qualquer forma.
- **Query builder sem ORM (Kysely, SQL puro).** Viável, mas o desafio pede MikroORM, e o Unit of Work dele simplifica gravar várias tabelas por transação.

## Consequências

- Os records espelham exatamente o banco; o domínio não sabe que existe um ORM.
- Toda mudança de schema exige migration revisada à mão, inclusive o `down`. O teste de schema aplica e reverte todas.
- A lista explícita funciona igual no Bun, no container e nos testes.
