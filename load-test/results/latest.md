# Resultado do teste de carga

Gerado em 2026-10-15T20:03:02.324Z por `bun run test:load`.

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
| Duração                                | 30.38 s             |
| Requisições                            | 5518                |
| Throughput                             | 181.6 req/s         |
| Erros (status fora de 200/201/202/422) | 0 (0.00%)           |
| Status                                 | 200: 294, 201: 5224 |

Latência observada pelo cliente:

| Tipo    | Amostras | p50      | p95      | p99      | máx       |
| ------- | -------- | -------- | -------- | -------- | --------- |
| todas   | 5518     | 241.7 ms | 451.0 ms | 700.8 ms | 1092.3 ms |
| BET     | 3587     | 249.4 ms | 451.0 ms | 668.8 ms | 1076.6 ms |
| WIN     | 845      | 245.6 ms | 478.6 ms | 764.3 ms | 1092.3 ms |
| LOSS    | 546      | 206.5 ms | 490.1 ms | 716.9 ms | 1027.0 ms |
| REFUND  | 246      | 266.2 ms | 472.6 ms | 864.8 ms | 963.0 ms  |
| replays | 294      | 140.0 ms | 249.5 ms | 437.5 ms | 447.4 ms  |

## Servidor (somado das instâncias)

| Métrica                                           | Valor                        |
| ------------------------------------------------- | ---------------------------- |
| Processamento p95 / p99 (histograma, interpolado) | 450.5 ms / 717.3 ms          |
| Espera do lock da wallet p50 / p95 / p99          | 9.9 ms / 172.1 ms / 446.7 ms |
| Conflitos de concorrência resolvidos com retry    | 0                            |
| Duplicatas respondidas como replay                | 294                          |
| Retries de mensagens SQS                          | 0                            |
| Mensagens enviadas à DLQ                          | 0                            |
| Falhas de publicação da outbox                    | 0                            |

## Outbox

| Métrica                                     | Valor  |
| ------------------------------------------- | ------ |
| Máximo de eventos pendentes                 | 154    |
| Lag máximo (evento pendente mais antigo)    | 0.60 s |
| Lag p95 (amostras de 1 s)                   | 0.48 s |
| Tempo para zerar a outbox após a carga HTTP | 0.26 s |

## SQS

| Métrica                         | Valor       |
| ------------------------------- | ----------- |
| Mensagens                       | 2000        |
| Tempo de envio                  | 2.62 s      |
| Tempo até a última ser aplicada | 19.43 s     |
| Throughput de consumo           | 103.0 msg/s |

## Correção após a carga

| Verificação                                              | Valor                       |
| -------------------------------------------------------- | --------------------------- |
| Wallets                                                  | 204                         |
| Wallets com saldo diferente do ledger reconstruído       | **0**                       |
| Lançamentos no ledger                                    | 6882                        |
| Transações                                               | 7428                        |
| Lançamentos contábeis (partidas dobradas)                | 6882                        |
| Lançamentos contábeis desbalanceados                     | **0**                       |
| Wallets com saldo diferente da conta contábil do jogador | **0**                       |
| Total de débitos / créditos no razão                     | 204050802.85 / 204050802.85 |

| Status    | failureCode | Quantidade |
| --------- | ----------- | ---------- |
| PROCESSED | —           | 7224       |
