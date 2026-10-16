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

Sobe o Keycloak, um serviço `migrate` (executa as migrations uma única vez) e três réplicas da aplicação em `http://localhost:3001`, `:3002` e `:3003`, todas com API, consumidor SQS, publisher da outbox e worker de referências pendentes ativos sobre o mesmo Postgres e as mesmas filas. Nesse modo a **autenticação está ligada** (ver [Autenticação](#autenticação)); para validar:

```bash
bun run auth:smoke
```

## Comandos

| Comando                    | O que faz                                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bun run dev`              | API com hot reload                                                                                                                                                                                                 |
| `bun run start`            | API sem hot reload                                                                                                                                                                                                 |
| `bun run db:migrate`       | aplica migrations pendentes                                                                                                                                                                                        |
| `bun run db:rollback`      | reverte a última migration                                                                                                                                                                                         |
| `bun run typecheck`        | checagem de tipos (`tsc --noEmit`)                                                                                                                                                                                 |
| `bun run format`           | Prettier                                                                                                                                                                                                           |
| `bun test`                 | toda a suíte                                                                                                                                                                                                       |
| `bun run test:unit`        | testes unitários (sem infraestrutura)                                                                                                                                                                              |
| `bun run test:integration` | Postgres e LocalStack reais                                                                                                                                                                                        |
| `bun run test:concurrency` | 3 processos da aplicação em paralelo, incluindo crash e restart                                                                                                                                                    |
| `bun run test:property`    | testes baseados em propriedades (fast-check): sequências aleatórias de operações verificando as invariantes, inclusive concorrência contra o Postgres; `FC_NUM_RUNS` / `FC_NUM_RUNS_DB` aumentam o número de casos |
| `bun run test:load`        | teste de carga com 3 instâncias; relatório em `load-test/results/latest.md`                                                                                                                                        |
| `bun run auth:smoke`       | valida a autenticação ponta a ponta contra o Keycloak e a aplicação (`--profile app`)                                                                                                                              |

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

A reconciliação compara três fontes: o saldo armazenado na wallet, o saldo reconstruído pelo ledger da wallet e o saldo da conta do jogador no razão contábil (`journalBalance`).

### Razão contábil (partidas dobradas)

Toda movimentação de saldo gera, na mesma transação SQL, um lançamento contábil com dois postings que se anulam: conta do jogador (`PLAYER:<walletId>`) contra a conta da casa do provedor (`HOUSE:<providerId>:<moeda>`) ou, no saldo de abertura, contra a conta de funding (`FUNDING:<moeda>`).

```bash
curl 'localhost:3000/ledger/trial-balance?currency=BRL'
```

O balancete devolve débitos, créditos e saldo por conta (contas de jogador agregadas), o total de débitos e créditos e `balanced: true` quando os dois fecham e nenhum lançamento está desbalanceado.

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

| Situação                                             | Status                     | Corpo                                                  |
| ---------------------------------------------------- | -------------------------- | ------------------------------------------------------ |
| Transação processada (primeira vez)                  | `201`                      | `status: PROCESSED`                                    |
| Replay idêntico                                      | `200`                      | resultado original, `idempotentReplay: true`           |
| Rejeição de regra de negócio                         | `422`                      | `status: REJECTED` + `failureCode`                     |
| Aceita, aguardando referência                        | `202`                      | `status: PENDING_REFERENCE`                            |
| Payload inválido / sem `Idempotency-Key`             | `400`                      | `error.code` (`INVALID_PAYLOAD`, `INVALID_MONEY`, ...) |
| Mesma chave com payload diferente / wallet duplicada | `409`                      | `IDEMPOTENCY_CONFLICT` / `WALLET_ALREADY_EXISTS`       |
| Wallet ou transação inexistente                      | `404`                      | `WALLET_NOT_FOUND` / `TRANSACTION_NOT_FOUND`           |
| Falha transitória de infraestrutura                  | `503` + `Retry-After`      | `INFRASTRUCTURE_UNAVAILABLE`                           |
| Sem token ou token inválido (autenticação ligada)    | `401` + `WWW-Authenticate` | `UNAUTHENTICATED`                                      |
| Papel insuficiente ou `providerId` de outro provedor | `403`                      | `FORBIDDEN`                                            |

### Operação

| Endpoint            | Uso                                        |
| ------------------- | ------------------------------------------ |
| `GET /health/live`  | processo vivo                              |
| `GET /health/ready` | Postgres e SQS alcançáveis (`200` / `503`) |
| `GET /metrics`      | métricas no formato Prometheus             |

Os endpoints de health e de métricas não exigem autenticação.

## Observabilidade

```bash
docker compose --profile app --profile observability up -d --build
```

| Ferramenta | Endereço               | O que mostra                                                                                                                                                                                                                                                                   |
| ---------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Grafana    | http://localhost:3100  | dashboard **Wagering service** (abre como página inicial): throughput por status, latência p50/p95/p99, espera do lock da wallet, duplicatas e conflitos, outbox (pendentes, lag, publicações), consumidor SQS, DLQ, divergências de reconciliação e CPU/memória por instância |
| Prometheus | http://localhost:9090  | coleta o `/metrics` das três réplicas a cada 5 s (e de `bun run dev` na porta 3000, via `host.docker.internal`)                                                                                                                                                                |
| Jaeger     | http://localhost:16686 | traces distribuídos do serviço `wagering-service`                                                                                                                                                                                                                              |

**Traces.** Com `OTEL_ENABLED=true` a aplicação exporta spans via OTLP/HTTP. Um trace segue a operação inteira:

```
POST /wagering/transactions            (continua um traceparent recebido, se houver)
└── db.transaction
    └── wallet.lock                    (SELECT ... FOR UPDATE: tempo de espera pelo lock)
publish WalletBalanceChanged           (worker da outbox, mesmo trace da requisição)
process wager-transactions             (consumidor SQS, continua o traceparent da mensagem)
└── db.transaction
    └── wallet.lock
```

O contexto do trace é gravado junto com o evento na outbox (coluna `headers`, na mesma transação SQL) e enviado como atributo `traceparent` da mensagem SQS; mensagens recebidas com `traceparent` continuam o trace do produtor. Toda resposta HTTP traz `x-trace-id`, e os logs JSON escritos dentro de um span trazem `traceId` e `spanId`, o que permite ir do log ao trace.

## Autenticação

A API valida tokens JWT emitidos por um **Keycloak** (OIDC, fluxo `client_credentials`): assinatura via JWKS, `iss`, `aud` (`wagering-api`) e expiração. Os papéis vêm de `realm_access.roles` e o provedor da claim `provider_id`.

O realm `wagering` é importado automaticamente de [docker/keycloak/realm](docker/keycloak/realm/wagering-realm.json):

| Client       | Secret              | Papel      | `provider_id` |
| ------------ | ------------------- | ---------- | ------------- |
| `provider-a` | `provider-a-secret` | `provider` | `provider-a`  |
| `provider-b` | `provider-b-secret` | `provider` | `provider-b`  |
| `backoffice` | `backoffice-secret` | `operator` | —             |

| Endpoint                                          | Quem acessa                                                                            |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `POST /wagering/transactions`                     | `provider`, somente com o próprio `providerId` no corpo (senão `403`)                  |
| `GET /wagering/transactions/:id`                  | `provider` (só transações do próprio provedor; as demais respondem `404`) e `operator` |
| `GET /providers/:providerId/...`                  | `provider` do mesmo `providerId` e `operator`                                          |
| `GET /wallets/:id`                                | `provider` e `operator`                                                                |
| `POST /wallets`, ledger, reconciliação, balancete | `operator`                                                                             |
| `/health/*`, `/metrics`                           | abertos                                                                                |

Mensagens da fila são um canal interno confiável e não carregam token; o `providerId` delas continua sujeito às validações de domínio.

```bash
TOKEN=$(curl -s -d grant_type=client_credentials -d client_id=provider-a -d client_secret=provider-a-secret   http://localhost:8080/realms/wagering/protocol/openid-connect/token | jq -r .access_token)

curl -H "Authorization: Bearer $TOKEN" localhost:3001/wagering/transactions/<transactionId>
```

No desenvolvimento local (`bun run dev`) a autenticação vem **desligada** (`AUTH_ENABLED=false`). Para ligá-la, suba o Keycloak com `docker compose --profile auth up -d keycloak` e use `AUTH_ENABLED=true` com as variáveis `AUTH_*` do `.env.example`. O console de administração fica em `http://localhost:8080` (admin / admin).

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

| Variável                                      | Padrão                  | Descrição                                                        |
| --------------------------------------------- | ----------------------- | ---------------------------------------------------------------- |
| `PORT`                                        | `3000`                  | porta HTTP                                                       |
| `DATABASE_URL`                                | —                       | conexão PostgreSQL                                               |
| `TEST_DATABASE_URL`                           | `.../wagering_test`     | banco usado pelos testes                                         |
| `AWS_REGION` / `AWS_ENDPOINT`                 | `us-east-1` / —         | região e endpoint do SQS (LocalStack)                            |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | —                       | credenciais (qualquer valor no LocalStack)                       |
| `SQS_TRANSACTIONS_QUEUE_URL`                  | —                       | fila de entrada                                                  |
| `SQS_TRANSACTIONS_DLQ_URL`                    | —                       | DLQ da entrada                                                   |
| `SQS_EVENTS_QUEUE_URL`                        | —                       | fila de eventos de integração                                    |
| `WORKERS_ENABLED`                             | `true`                  | liga consumidor SQS, publisher da outbox e worker de referências |
| `RUN_MIGRATIONS`                              | `false`                 | aplica migrations ao subir                                       |
| `SQS_WAIT_TIME_SECONDS`                       | `20`                    | long polling do consumidor                                       |
| `SQS_RETRY_BASE_SECONDS`                      | `2`                     | base do backoff de falhas transitórias                           |
| `SQS_CONSUMER_POLLERS`                        | `4`                     | loops de long polling concorrentes por instância                 |
| `OUTBOX_POLL_INTERVAL_MS`                     | `500`                   | intervalo ocioso do publisher                                    |
| `PENDING_REFERENCE_POLL_INTERVAL_MS`          | `1000`                  | intervalo ocioso do worker de referências                        |
| `LOG_LEVEL`                                   | `info`                  | `trace`, `debug`, `info`, `warn`, `error`                        |
| `DB_DEBUG`                                    | `false`                 | imprime o SQL executado pelo ORM                                 |
| `AUTH_ENABLED`                                | `false`                 | liga a validação de JWT                                          |
| `AUTH_ISSUER`                                 | —                       | `iss` esperado (`http://localhost:8080/realms/wagering`)         |
| `AUTH_AUDIENCE`                               | —                       | `aud` esperado (`wagering-api`)                                  |
| `AUTH_JWKS_URL`                               | —                       | endpoint de chaves públicas do Keycloak                          |
| `AUTH_PROVIDER_CLAIM`                         | `provider_id`           | claim com o identificador do provedor                            |
| `OTEL_ENABLED`                                | `false`                 | liga a exportação de traces                                      |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                 | `http://localhost:4318` | coletor OTLP/HTTP (Jaeger)                                       |
| `OTEL_SERVICE_NAME`                           | `wagering-service`      | nome do serviço nos traces                                       |

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
