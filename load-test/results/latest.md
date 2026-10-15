# Resultado do teste de carga

Gerado em 2026-10-15T18:19:16.498Z por `bun run test:load`.

## Ambiente

| Item       | Valor                                   |
| ---------- | --------------------------------------- |
| Sistema    | Windows_NT 10.0.26200 (x64)             |
| CPU        | 13th Gen Intel(R) Core(TM) i7-1355U x12 |
| Memória    | 32 GB                                   |
| Bun        | 1.4.3                                   |
| PostgreSQL | 17.11                                   |

## Parâmetros

| Parâmetro       | Valor |
| --------------- | ----- |
| instances       | 3     |
| durationSeconds | 30    |
| concurrency     | 48    |
| wallets         | 200   |
| hotWallets      | 4     |
| hotShare        | 0.2   |
| sqsMessages     | 2000  |

## HTTP

| Métrica                                | Valor               |
| -------------------------------------- | ------------------- |
| Duração                                | 30.17 s             |
| Requisições                            | 8037                |
| Throughput                             | 266.4 req/s         |
| Erros (status fora de 200/201/202/422) | 0 (0.00%)           |
| Status                                 | 200: 397, 201: 7640 |

Latência observada pelo cliente:

| Tipo    | Amostras | p50      | p95      | p99      | máx      |
| ------- | -------- | -------- | -------- | -------- | -------- |
| todas   | 8037     | 165.1 ms | 309.6 ms | 439.1 ms | 826.6 ms |
| BET     | 5244     | 168.2 ms | 315.2 ms | 444.1 ms | 826.6 ms |
| WIN     | 1221     | 169.4 ms | 301.3 ms | 439.1 ms | 661.1 ms |
| LOSS    | 786      | 150.4 ms | 300.4 ms | 448.6 ms | 633.8 ms |
| REFUND  | 389      | 187.5 ms | 311.8 ms | 478.9 ms | 654.4 ms |
| replays | 397      | 100.5 ms | 173.2 ms | 311.1 ms | 337.4 ms |

## Servidor (somado das instâncias)

| Métrica                                           | Valor                        |
| ------------------------------------------------- | ---------------------------- |
| Processamento p95 / p99 (histograma, interpolado) | 297.3 ms / 439.5 ms          |
| Espera do lock da wallet p50 / p95 / p99          | 9.9 ms / 129.2 ms / 281.4 ms |
| Conflitos de concorrência resolvidos com retry    | 0                            |
| Duplicatas respondidas como replay                | 397                          |
| Retries de mensagens SQS                          | 0                            |
| Mensagens enviadas à DLQ                          | 0                            |
| Falhas de publicação da outbox                    | 0                            |

## Outbox

| Métrica                                     | Valor  |
| ------------------------------------------- | ------ |
| Máximo de eventos pendentes                 | 329    |
| Lag máximo (evento pendente mais antigo)    | 0.74 s |
| Lag p95 (amostras de 1 s)                   | 0.63 s |
| Tempo para zerar a outbox após a carga HTTP | 0.26 s |

## SQS

| Métrica                         | Valor      |
| ------------------------------- | ---------- |
| Mensagens                       | 2000       |
| Tempo de envio                  | 2.15 s     |
| Tempo até a última ser aplicada | 20.70 s    |
| Throughput de consumo           | 96.6 msg/s |

## Correção após a carga

| Verificação                                        | Valor |
| -------------------------------------------------- | ----- |
| Wallets                                            | 204   |
| Wallets com saldo diferente do ledger reconstruído | **0** |
| Lançamentos no ledger                              | 9058  |
| Transações                                         | 9844  |

| Status    | failureCode | Quantidade |
| --------- | ----------- | ---------- |
| PROCESSED | —           | 9640       |
