# Resultado do teste de carga

Gerado em 2026-10-16T18:41:04.984Z por `bun run test:load`.

## Ambiente

| Item | Valor |
|---|---|
| Sistema | Windows_NT 10.0.26200 (x64) |
| CPU | 13th Gen Intel(R) Core(TM) i7-1355U x12 |
| Memória | 32 GB |
| Bun | 1.4.3 |
| PostgreSQL | 17.11 |

## Parâmetros

| Parâmetro | Valor |
|---|---|
| instances | 3 |
| durationSeconds | 30 |
| concurrency | 48 |
| wallets | 200 |
| hotWallets | 4 |
| hotShare | 0.2 |
| sqsMessages | 2000 |

## HTTP

| Métrica | Valor |
|---|---|
| Duração | 30.18 s |
| Requisições | 7535 |
| Throughput | 249.7 req/s |
| Erros (status fora de 200/201/202/422) | 0 (0.00%) |
| Status | 200: 400, 201: 7135 |

Latência observada pelo cliente:

| Tipo | Amostras | p50 | p95 | p99 | máx |
|---|---|---|---|---|---|
| todas | 7535 | 174.6 ms | 343.5 ms | 529.8 ms | 1299.8 ms |
| BET | 4852 | 181.7 ms | 347.8 ms | 538.6 ms | 1209.1 ms |
| WIN | 1142 | 180.7 ms | 358.6 ms | 503.3 ms | 846.1 ms |
| LOSS | 773 | 146.4 ms | 313.8 ms | 530.8 ms | 1299.8 ms |
| REFUND | 368 | 193.5 ms | 369.4 ms | 648.2 ms | 900.2 ms |
| replays | 400 | 95.4 ms | 190.6 ms | 274.6 ms | 496.4 ms |

## Servidor (somado das instâncias)

| Métrica | Valor |
|---|---|
| Processamento p95 / p99 (histograma, interpolado) | 346.3 ms / 536.0 ms |
| Espera do lock da wallet p50 / p95 / p99 | 7.2 ms / 132.6 ms / 313.3 ms |
| Conflitos de concorrência resolvidos com retry | 0 |
| Duplicatas respondidas como replay | 400 |
| Retries de mensagens SQS | 0 |
| Mensagens enviadas à DLQ | 0 |
| Falhas de publicação da outbox | 0 |

## Outbox

| Métrica | Valor |
|---|---|
| Máximo de eventos pendentes | 272 |
| Lag máximo (evento pendente mais antigo) | 0.92 s |
| Lag p95 (amostras de 1 s) | 0.63 s |
| Tempo para zerar a outbox após a carga HTTP | 0.26 s |

## SQS

| Métrica | Valor |
|---|---|
| Mensagens | 2000 |
| Tempo de envio | 2.21 s |
| Tempo até a última ser aplicada | 15.95 s |
| Throughput de consumo | 125.4 msg/s |

## Correção após a carga

| Verificação | Valor |
|---|---|
| Wallets | 204 |
| Wallets com saldo diferente do ledger reconstruído | **0** |
| Lançamentos no ledger | 8566 |
| Transações | 9339 |
| Lançamentos contábeis (partidas dobradas) | 8566 |
| Lançamentos contábeis desbalanceados | **0** |
| Wallets com saldo diferente da conta contábil do jogador | **0** |
| Total de débitos / créditos no razão | 204068554.74 / 204068554.74 |

| Status | failureCode | Quantidade |
|---|---|---|
| PROCESSED | — | 9135 |
