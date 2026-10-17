# Testes e CI

> Decisão relacionada: [ADR 0011](../adr/0011-test-against-real-postgres-and-sqs.md).

## Estratégia

Nenhum teste substitui Postgres ou SQS por mocks. As garantias mais importantes do sistema (locks, constraints, triggers deferidos, `SKIP LOCKED`, FIFO, visibility timeout) são comportamentos da infraestrutura, e um mock reproduziria a nossa suposição sobre eles, não o comportamento real.

| Nível        | Onde                 | Cobre                                                                                                                                                                                                                                                                                                                     |
| ------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unitário     | `test/unit`          | `Money` (escala, entradas inválidas, `bigint` além de `MAX_SAFE_INTEGER`), invariantes de `Wallet` e do ledger, partidas dobradas, máquina de estados, todas as regras de `BET`/`WIN`/`LOSS`/`REFUND`/`ROLLBACK`, hash de payload, outbox, cursor do ledger, logger, contrato OpenAPI × rotas                             |
| Integração   | `test/integration`   | migrations reversíveis e cada constraint do schema; atomicidade de wallet, ledger, inbox e outbox; idempotência, replay e conflito; inbox e redelivery; publishers concorrentes; retry, DLQ e redrive; `SIGTERM`; referências fora de ordem; API HTTP completa; autenticação; tracing; retenção e reconciliação periódica |
| Concorrência | `test/concurrency`   | **três processos da aplicação** sobre o mesmo Postgres e as mesmas filas, incluindo uma instância morta no meio da carga                                                                                                                                                                                                  |
| Propriedades | `*.property.test.ts` | sequências aleatórias de operações (fast-check) verificando as invariantes de saldo, ledger e reversão, no domínio e contra o Postgres com concorrência real                                                                                                                                                              |
| Carga        | `load-test/`         | throughput e latência com três instâncias; relatório em `load-test/REPORT.md`                                                                                                                                                                                                                                             |

A invariante `saldo da wallet == saldo reconstruído pelo ledger` é verificada nos testes de integração e concorrência. Os testes de mensageria e concorrência criam filas FIFO temporárias por execução, e os de banco usam o banco `wagering_test`, então a suíte roda com a aplicação de desenvolvimento ligada.

Os testes de propriedade são determinísticos por seed: uma falha imprime a seed, e `FC_SEED=<seed>` reproduz o caso exato. `FC_NUM_RUNS` e `FC_NUM_RUNS_DB` aumentam o número de casos.

## Cenários exigidos pelo enunciado

| Cenário                                         | Teste                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Mesma aposta 50 vezes em paralelo → um débito   | `process-wager-transaction.test.ts`                                                         |
| Saldo 100.00, duas apostas de 80.00 simultâneas | `process-wager-transaction.test.ts` e `multi-instance.test.ts` (cada aposta numa instância) |
| Wallets distintas em paralelo                   | `process-wager-transaction.test.ts`                                                         |
| ≥ 3 instâncias simultâneas                      | `multi-instance.test.ts` (HTTP, SQS, outbox e worker)                                       |
| Worker morto depois do commit e antes do ack    | `messaging.test.ts`                                                                         |
| Dois publishers sobre a mesma outbox            | `messaging.test.ts` e `multi-instance.test.ts` (três publishers)                            |
| `ROLLBACK`/`REFUND` antes da referência         | `messaging.test.ts` e `multi-instance.test.ts` (instâncias diferentes)                      |
| Reinício do serviço com consistência final      | `multi-instance.test.ts` (instância morta no meio da carga e substituída)                   |

## CI

`.github/workflows/ci.yml` roda em todo push na `main` e em pull requests, com três jobs em paralelo. Localmente, `bun run check` executa as mesmas etapas em sequência (`--quick` pula as que precisam de Docker).

| Job              | O que valida                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `static`         | Prettier, typecheck e testes unitários (inclusive o contrato OpenAPI)                                                                                  |
| `integration`    | sobe Postgres e LocalStack pelo próprio `docker-compose.yml` (mesmos scripts de init do ambiente local) e roda integração, concorrência e propriedades |
| `infrastructure` | `docker compose config`, `promtool check` da configuração e das regras, `promtool test rules` dos alertas e build da imagem                            |
