# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas de provedores de jogos via **HTTP** e **SQS**, mantendo saldo, ledger auditável e eventos de integração corretos sob mensagens duplicadas, fora de ordem e processamento concorrente em múltiplas instâncias.

- Enunciado: [CHALLENGE.md](CHALLENGE.md)

## Stack

| Item                               | Escolha                                                               |
| ---------------------------------- | --------------------------------------------------------------------- |
| Runtime / package manager / testes | Bun 1.x                                                               |
| Linguagem                          | TypeScript (strict)                                                   |
| Framework                          | NestJS                                                                |
| Banco                              | PostgreSQL 17                                                         |
| ORM / migrations                   | MikroORM 7 (`EntitySchema`, migrations SQL versionadas e reversíveis) |
| Mensageria                         | AWS SQS FIFO via LocalStack                                           |
| Validação de contratos             | zod                                                                   |
| Métricas                           | prom-client (formato Prometheus)                                      |

## Requisitos

- [Bun](https://bun.sh) 1.x
- Docker + Docker Compose

## Subindo o ambiente

```bash
bun install
cp .env.example .env

docker compose up -d          # Postgres + LocalStack (filas criadas automaticamente)
docker compose ps             # aguarde os dois serviços ficarem "healthy"

bun run db:migrate            # aplica as migrations no banco de desenvolvimento
bun run dev                   # API em http://localhost:3000 (com workers e consumidor SQS)
```

O `docker compose up` cria dois bancos (`wagering` para desenvolvimento e `wagering_test` para os testes) e três filas FIFO:

| Fila                          | Papel                                                  |
| ----------------------------- | ------------------------------------------------------ |
| `wager-transactions.fifo`     | entrada de transações dos provedores                   |
| `wager-transactions-dlq.fifo` | DLQ da entrada (`maxReceiveCount = 5`)                 |
| `wager-events.fifo`           | saída dos eventos de integração publicados pela outbox |

### Três instâncias em containers

```bash
docker compose --profile app up -d --build
```

Sobe um serviço `migrate` (executa as migrations uma única vez) e três réplicas da aplicação em `http://localhost:3001`, `:3002` e `:3003`, todas com API, consumidor SQS, publisher da outbox e worker de referências pendentes ativos sobre o mesmo Postgres e as mesmas filas.

## Comandos

| Comando                    | O que faz                                                                   |
| -------------------------- | --------------------------------------------------------------------------- |
| `bun run dev`              | API com hot reload                                                          |
| `bun run start`            | API sem hot reload                                                          |
| `bun run db:migrate`       | aplica migrations pendentes                                                 |
| `bun run db:rollback`      | reverte a última migration                                                  |
| `bun run typecheck`        | checagem de tipos (`tsc --noEmit`)                                          |
| `bun run format`           | Prettier                                                                    |
| `bun test`                 | toda a suíte                                                                |
| `bun run test:unit`        | testes unitários (sem infraestrutura)                                       |
| `bun run test:integration` | Postgres e LocalStack reais                                                 |
| `bun run test:concurrency` | 3 processos da aplicação em paralelo, incluindo crash e restart             |
| `bun run test:load`        | teste de carga com 3 instâncias; relatório em `load-test/results/latest.md` |

Os testes de integração e concorrência precisam do `docker compose up -d`. Eles usam o banco `wagering_test` e criam filas temporárias próprias no LocalStack, então podem rodar com a aplicação de desenvolvimento ligada.

### Teste de carga

```bash
bun run test:load
```

Cria (se necessário) o banco `wagering_load`, sobe 3 instâncias da aplicação, abre 204 wallets (4 delas "quentes", que recebem 20% do tráfego), aplica 30 s de carga HTTP com 48 usuários virtuais (mistura de `BET`, `WIN`, `LOSS`, `REFUND` e 5% de replays), envia 2.000 mensagens pela fila e, ao final, verifica que o saldo de toda wallet é igual ao saldo reconstruído pelo ledger. O resultado vai para `load-test/results/latest.md` e `latest.json`; metodologia e análise estão em [load-test/REPORT.md](load-test/REPORT.md).

| Variável                            | Padrão              |
| ----------------------------------- | ------------------- |
| `LOAD_INSTANCES`                    | `3`                 |
| `LOAD_DURATION_SECONDS`             | `30`                |
| `LOAD_CONCURRENCY`                  | `48`                |
| `LOAD_WALLETS` / `LOAD_HOT_WALLETS` | `200` / `4`         |
| `LOAD_HOT_SHARE`                    | `0.2`               |
| `LOAD_SQS_MESSAGES`                 | `2000`              |
| `LOAD_DATABASE_URL`                 | `.../wagering_load` |

## API

Todos os valores monetários trafegam como string decimal com exatamente duas casas: `{ "amount": "25.00", "currency": "BRL" }`. Toda resposta carrega o header `x-correlation-id` (reaproveitado da requisição quando enviado).

### Wallets

```bash
curl -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

curl localhost:3000/wallets/<walletId>
curl 'localhost:3000/wallets/<walletId>/ledger?limit=50&cursor=<nextCursor>'
curl -X POST localhost:3000/wallets/<walletId>/reconciliation
```

### Transações

```bash
curl -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "<walletId>",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'

curl localhost:3000/wagering/transactions/<transactionId>
curl localhost:3000/providers/provider-a/wagering/transactions/transaction-123
```

`REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`.

### Status HTTP

| Situação                                             | Status                | Corpo                                                  |
| ---------------------------------------------------- | --------------------- | ------------------------------------------------------ |
| Transação processada (primeira vez)                  | `201`                 | `status: PROCESSED`                                    |
| Replay idêntico                                      | `200`                 | resultado original, `idempotentReplay: true`           |
| Rejeição de regra de negócio                         | `422`                 | `status: REJECTED` + `failureCode`                     |
| Aceita, aguardando referência                        | `202`                 | `status: PENDING_REFERENCE`                            |
| Payload inválido / sem `Idempotency-Key`             | `400`                 | `error.code` (`INVALID_PAYLOAD`, `INVALID_MONEY`, ...) |
| Mesma chave com payload diferente / wallet duplicada | `409`                 | `IDEMPOTENCY_CONFLICT` / `WALLET_ALREADY_EXISTS`       |
| Wallet ou transação inexistente                      | `404`                 | `WALLET_NOT_FOUND` / `TRANSACTION_NOT_FOUND`           |
| Falha transitória de infraestrutura                  | `503` + `Retry-After` | `INFRASTRUCTURE_UNAVAILABLE`                           |

### Operação

| Endpoint            | Uso                                        |
| ------------------- | ------------------------------------------ |
| `GET /health/live`  | processo vivo                              |
| `GET /health/ready` | Postgres e SQS alcançáveis (`200` / `503`) |
| `GET /metrics`      | métricas no formato Prometheus             |

Os endpoints de health e de métricas não exigem autenticação.

## Enviando uma transação pela fila

```bash
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> \
  --message-deduplication-id msg-123 \
  --message-body '{
    "messageId": "msg-123",
    "type": "WagerTransactionRequested",
    "occurredAt": "2026-07-29T15:00:00.000Z",
    "data": {
      "providerId": "provider-a",
      "externalTransactionId": "transaction-456",
      "idempotencyKey": "provider-a:transaction-456",
      "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
      "walletId": "<walletId>",
      "roundId": "round-987",
      "gameId": "fortune-chimp",
      "kind": "BET",
      "money": { "amount": "25.00", "currency": "BRL" }
    }
  }'
```

Para ver os eventos publicados:

```bash
docker compose exec localstack awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/wager-events.fifo --max-number-of-messages 10
```

## Variáveis de ambiente

| Variável                                      | Padrão              | Descrição                                                        |
| --------------------------------------------- | ------------------- | ---------------------------------------------------------------- |
| `PORT`                                        | `3000`              | porta HTTP                                                       |
| `DATABASE_URL`                                | —                   | conexão PostgreSQL                                               |
| `TEST_DATABASE_URL`                           | `.../wagering_test` | banco usado pelos testes                                         |
| `AWS_REGION` / `AWS_ENDPOINT`                 | `us-east-1` / —     | região e endpoint do SQS (LocalStack)                            |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | —                   | credenciais (qualquer valor no LocalStack)                       |
| `SQS_TRANSACTIONS_QUEUE_URL`                  | —                   | fila de entrada                                                  |
| `SQS_TRANSACTIONS_DLQ_URL`                    | —                   | DLQ da entrada                                                   |
| `SQS_EVENTS_QUEUE_URL`                        | —                   | fila de eventos de integração                                    |
| `WORKERS_ENABLED`                             | `true`              | liga consumidor SQS, publisher da outbox e worker de referências |
| `RUN_MIGRATIONS`                              | `false`             | aplica migrations ao subir                                       |
| `SQS_WAIT_TIME_SECONDS`                       | `20`                | long polling do consumidor                                       |
| `SQS_RETRY_BASE_SECONDS`                      | `2`                 | base do backoff de falhas transitórias                           |
| `SQS_CONSUMER_POLLERS`                        | `4`                 | loops de long polling concorrentes por instância                 |
| `OUTBOX_POLL_INTERVAL_MS`                     | `500`               | intervalo ocioso do publisher                                    |
| `PENDING_REFERENCE_POLL_INTERVAL_MS`          | `1000`              | intervalo ocioso do worker de referências                        |
| `LOG_LEVEL`                                   | `info`              | `trace`, `debug`, `info`, `warn`, `error`                        |
| `DB_DEBUG`                                    | `false`             | imprime o SQL executado pelo ORM                                 |

## Estrutura

```
src/
├── domain/          regras de negócio puras: Money, Wallet, WagerTransaction, ledger, eventos, inbox/outbox
├── application/     casos de uso e ports (interfaces que a infraestrutura implementa)
├── infrastructure/  MikroORM, SQS, logs JSON, métricas, workers
└── interfaces/      controllers HTTP, consumidor SQS, ciclo de vida dos workers
test/
├── unit/            domínio e aplicação, sem I/O
├── integration/     Postgres e LocalStack reais
└── concurrency/     três processos da aplicação em paralelo
load-test/           gerador de carga, relatório e resultados
```
