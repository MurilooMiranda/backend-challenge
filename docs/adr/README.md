# Architecture Decision Records

Cada arquivo registra uma decisão arquiteturalmente significativa: o contexto em que foi tomada, o que foi decidido, as alternativas descartadas e as consequências aceitas. O formato é o de Michael Nygard, e os nomes de arquivo seguem o [adr-tools](https://github.com/npryce/adr-tools). O processo está descrito na [ADR 0001](0001-record-architecture-decisions.md).

| ADR                                                                    | Decisão                                                               | Status |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------- | ------ |
| [0001](0001-record-architecture-decisions.md)                          | Registrar decisões de arquitetura                                     | Aceito |
| [0002](0002-ports-and-adapters-with-a-pure-domain.md)                  | Ports and adapters com domínio puro                                   | Aceito |
| [0003](0003-represent-money-as-bigint-minor-units.md)                  | Representar dinheiro como `bigint` em centavos                        | Aceito |
| [0004](0004-serialize-wallet-operations-with-pessimistic-row-locks.md) | Serializar operações por wallet com lock pessimista de linha          | Aceito |
| [0005](0005-idempotency-key-with-canonical-payload-hash.md)            | Idempotência por chave com hash canônico do payload                   | Aceito |
| [0006](0006-enforce-ledger-invariants-in-the-database.md)              | Garantir as invariantes do ledger no banco                            | Aceito |
| [0007](0007-mikroorm-with-hand-written-sql-migrations.md)              | MikroORM com `EntitySchema` e migrations em SQL escrito à mão         | Aceito |
| [0008](0008-transactional-outbox-and-inbox.md)                         | Transactional outbox para eventos e inbox para mensagens recebidas    | Aceito |
| [0009](0009-out-of-order-references-as-pending-state.md)               | Referências fora de ordem como estado `PENDING_REFERENCE`             | Aceito |
| [0010](0010-a-reference-can-be-reversed-at-most-once.md)               | Uma transação pode ser revertida no máximo uma vez, por qualquer tipo | Aceito |
| [0011](0011-test-against-real-postgres-and-sqs.md)                     | Testar contra Postgres e SQS reais, sem mocks                         | Aceito |
| [0012](0012-double-entry-general-ledger.md)                            | Razão geral de partidas dobradas ao lado do ledger da wallet          | Aceito |
| [0013](0013-keycloak-oidc-client-credentials.md)                       | Autenticação com Keycloak (OIDC, client credentials)                  | Aceito |
| [0014](0014-manual-opentelemetry-instrumentation.md)                   | Instrumentação manual com OpenTelemetry e contexto de trace na outbox | Aceito |
| [0015](0015-bounded-retention-for-inbox-and-outbox.md)                 | Retenção limitada para inbox e outbox                                 | Aceito |
| [0016](0016-detect-not-correct-balance-divergences.md)                 | Reconciliação periódica que detecta e não corrige divergências        | Aceito |
| [0017](0017-spec-first-openapi-contract.md)                            | Contrato OpenAPI escrito à mão e verificado contra as rotas           | Aceito |

## Como propor uma nova decisão

1. Copie [template.md](template.md) para `NNNN-titulo-em-kebab-case.md`, com o próximo número livre.
2. Abra com status `Proposto` no mesmo pull request da mudança de código.
3. Ao aprovar o pull request, mude para `Aceito` e acrescente a linha nesta tabela.
4. Para reverter uma decisão aceita, escreva uma nova ADR e marque a antiga como `Substituído por [ADR NNNN](...)`. Não reescreva a antiga.
