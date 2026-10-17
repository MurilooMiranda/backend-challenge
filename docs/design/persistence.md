# Persistência e invariantes no banco

> Decisões relacionadas: [ADR 0006](../adr/0006-enforce-ledger-invariants-in-the-database.md) (invariantes no banco), [ADR 0012](../adr/0012-double-entry-general-ledger.md) (partidas dobradas), [ADR 0007](../adr/0007-mikroorm-with-hand-written-sql-migrations.md) (ORM e migrations).

## ORM

**MikroORM** com `EntitySchema`: classes de record sem decorators, espelho 1:1 das tabelas (`infrastructure/persistence/records.ts`), convertidas de e para o domínio por mappers explícitos (`mappers.ts`). O domínio não carrega tipos nem metadados do ORM.

Cada unidade de trabalho usa `orm.em.fork().transactional(...)`: um `EntityManager` novo, com identity map limpo, por tentativa, e flush único no commit. O lock da wallet usa `LockMode.PESSIMISTIC_WRITE` (`SELECT ... FOR UPDATE`).

## Migrations

Escritas à mão em SQL, com `up` e `down`, em `infrastructure/persistence/migrations`. O gerador de schema não cria triggers, constraint triggers deferidas nem índices parciais, e são justamente esses recursos que garantem as invariantes. A lista é explícita (`migrationsList`), sem descoberta por glob, o que funciona igual no Bun, no container e nos testes.

| Migration                            | Conteúdo                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `Migration20261014InitialSchema`     | wallets, transações, ledger, inbox, outbox, constraints e triggers            |
| `Migration20261015OutboxAggregateIndex` | índice parcial `(aggregate_id, sequence)` das mensagens pendentes, usado no claim por wallet do publisher |
| `Migration20261016DoubleEntryLedger` | razão de partidas dobradas, triggers de balanceamento e backfill do histórico |
| `Migration20261017OutboxHeaders`     | coluna `headers` da outbox (contexto de trace)                                |
| `Migration20261018RetentionIndexes`  | índices parciais para a limpeza de inbox e outbox                             |

As FKs são `DEFERRABLE INITIALLY DEFERRED`: os records não declaram relações, e o Unit of Work pode ordenar os INSERTs livremente dentro da transação. A verificação acontece no COMMIT.

`test/integration/schema.test.ts` aplica e reverte todas as migrations e tenta violar cada regra abaixo com SQL puro, contornando o domínio.

## Invariantes garantidas no banco

O domínio valida tudo antes de gravar, mas o banco é a última linha de defesa: nenhum caminho de código, script manual ou bug futuro consegue gravar um estado inválido.

| Invariante                                                                                                            | Mecanismo                                                                                    |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Saldo nunca negativo                                                                                                  | `CHECK (balance >= 0)`, `CHECK (balance_after >= 0)`                                         |
| Uma wallet por player + moeda                                                                                         | `UNIQUE (player_id, currency)`                                                               |
| Saldo da wallet = último `balance_after` do ledger                                                                    | constraint trigger **deferida** em `wallets` e `wallet_ledger_entries`, verificada no COMMIT |
| Lançamento aritmeticamente correto                                                                                    | `CHECK ledger_balanced` (`before ± amount = after`)                                          |
| Ledger sem buracos                                                                                                    | trigger `BEFORE INSERT`: `balance_before` = `balance_after` do lançamento anterior           |
| Ledger imutável                                                                                                       | trigger que bloqueia `UPDATE` e `DELETE`                                                     |
| No máximo um lançamento por transação e wallet                                                                        | `UNIQUE (transaction_id, wallet_id)`                                                         |
| Moeda do lançamento = moeda da wallet                                                                                 | FK composta `(wallet_id, currency) → wallets (id, currency)`                                 |
| Idempotência                                                                                                          | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`                 |
| Uma referência revertida no máximo uma vez                                                                            | índice único parcial em `reference_transaction_id` para `REFUND`/`ROLLBACK` `PROCESSED`      |
| Transação terminal imutável e nunca apagada                                                                           | trigger `BEFORE UPDATE OR DELETE`                                                            |
| `REFUND`/`ROLLBACK` com referência; `failure_code` se e só se `REJECTED`/`FAILED`; `processed_at` se e só se terminal | `CHECK`                                                                                      |
| Inbox deduplicada                                                                                                     | `PRIMARY KEY (consumer_name, message_id)`                                                    |

**Por que deferida.** Dentro de uma transação, a wallet e o lançamento do ledger são gravados em instruções separadas; entre elas, o estado é momentaneamente inconsistente. Uma constraint trigger `DEFERRABLE INITIALLY DEFERRED` só roda no COMMIT, quando os dois já foram gravados, e aborta a transação inteira se não baterem.

## Partidas dobradas

O ledger da wallet (`wallet_ledger_entries`) é o **subledger** do jogador: uma linha por movimentação, com `balance_before` e `balance_after` em corrente. Ao lado dele existe um **razão geral** de partidas dobradas:

| Tabela             | Conteúdo                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `ledger_accounts`  | plano de contas: `PLAYER:<walletId>` (uma por wallet), `HOUSE:<providerId>:<moeda>` e `FUNDING:<moeda>` |
| `journal_entries`  | um lançamento contábil por transação que move saldo                                                     |
| `journal_postings` | os postings de cada lançamento (conta, direção, valor)                                                  |

Toda movimentação gera, na mesma transação SQL, um lançamento com dois postings que se anulam:

| Operação            | Débito                     | Crédito                    |
| ------------------- | -------------------------- | -------------------------- |
| Abertura            | `FUNDING:<moeda>`          | `PLAYER:<walletId>`        |
| `BET`               | `PLAYER:<walletId>`        | `HOUSE:<provider>:<moeda>` |
| `WIN`               | `HOUSE:<provider>:<moeda>` | `PLAYER:<walletId>`        |
| `REFUND`/`ROLLBACK` | o inverso da referência    |                            |

O domínio modela isso em `JournalEntry` (débitos = créditos, pelo menos dois postings, mesma moeda, contas distintas) e `LedgerAccount` (plano de contas e contraparte por tipo de operação). O banco garante, no COMMIT:

| Invariante                                                                                   | Mecanismo                                                             |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Débitos = créditos em todo lançamento, com pelo menos dois postings                          | constraint trigger deferida em `journal_entries` e `journal_postings` |
| Todo lançamento da wallet tem posting igual na conta do jogador                              | constraint trigger deferida em `wallet_ledger_entries`                |
| Todo posting em conta de jogador tem lançamento igual na wallet                              | constraint trigger deferida em `journal_postings`                     |
| Um lançamento contábil por transação                                                         | `UNIQUE (transaction_id)`                                             |
| Moeda do posting = moeda do lançamento = moeda da conta; conta do jogador na moeda da wallet | FKs compostas `(…, currency)`                                         |
| Contas, lançamentos e postings imutáveis                                                     | trigger que bloqueia `UPDATE` e `DELETE`                              |

Com isso, o saldo da wallet, o ledger da wallet e a conta contábil do jogador não podem divergir, e o balancete (`GET /ledger/trial-balance`) sempre fecha.

**Contas sem saldo materializado.** As contas da casa e de funding não guardam saldo: toda aposta de um provedor precisaria travar a mesma linha, um lock global que o enunciado proíbe. O saldo delas é a soma dos postings. As contas são criadas sob demanda com `INSERT … ON CONFLICT DO NOTHING`, sem alvo, para cobrir as duas constraints únicas da tabela (a versão com alvo falhou no teste de concorrência). O processamento de uma aposta garante a conta da casa **antes** de travar a wallet, para não alongar a seção crítica.

A migration que introduziu o razão faz o backfill dos lançamentos que já existiam, e há um teste para isso. O custo medido no teste de carga é de cerca de 25–30% do throughput (ver `load-test/REPORT.md`).
