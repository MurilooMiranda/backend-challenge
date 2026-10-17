# Observabilidade

> Decisões relacionadas: [ADR 0014](../adr/0014-manual-opentelemetry-instrumentation.md) (tracing) e [ADR 0016](../adr/0016-detect-not-correct-balance-divergences.md) (reconciliação periódica). O que fazer quando um alerta dispara: [runbooks/alerts.md](../runbooks/alerts.md).

## Logs

JSON, uma linha por evento, no stdout (`src/infrastructure/observability/json-logger.ts`). Um `AsyncLocalStorage` propaga `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId` por toda a requisição ou mensagem, sem passar contexto à mão. Logs escritos dentro de um span carregam `traceId` e `spanId`. Valores monetários e payloads não são logados.

## Métricas

`GET /metrics`, formato Prometheus (`src/infrastructure/observability/prometheus-telemetry.ts`). A aplicação depende só da interface `Telemetry` (`src/application/telemetry.ts`); o Prometheus é um detalhe de infraestrutura.

| Métrica                                                                                            | Tipo                                           |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `wager_transactions_total{channel,kind,status}`                                                    | counter                                        |
| `wager_duplicates_total{channel}`                                                                  | counter                                        |
| `wager_processing_duration_seconds{channel}`                                                       | histogram                                      |
| `wallet_lock_wait_seconds`                                                                         | histogram                                      |
| `wallet_lock_conflicts_total{reason}`                                                              | counter                                        |
| `sqs_messages_consumed_total{outcome}`                                                             | counter                                        |
| `sqs_message_retries_total`                                                                        | counter                                        |
| `sqs_messages_dead_lettered_total{failure_code}`                                                   | counter                                        |
| `sqs_dead_letter_queue_messages`                                                                   | gauge (lido do SQS na coleta)                  |
| `outbox_messages_total{result}`                                                                    | counter                                        |
| `outbox_pending_messages`, `outbox_lag_seconds`                                                    | gauge (idade da mensagem pendente mais antiga) |
| `wallet_reconciliations_total{result}`                                                             | counter                                        |
| `wallet_reconciliation_scans_total{result}`                                                        | counter                                        |
| `wallet_reconciliation_divergent_wallets`                                                          | gauge (resultado da última varredura)          |
| `wallet_reconciliation_last_scan_timestamp_seconds`, `wallet_reconciliation_scan_duration_seconds` | gauge                                          |
| `messaging_retention_deleted_total{table}`                                                         | counter                                        |

O dashboard **Wagering service** do Grafana é provisionado de `docker/observability/grafana/dashboards/wagering.json`.

## Traces

OpenTelemetry, opcional (`OTEL_ENABLED=true`), exportado via OTLP/HTTP para o Jaeger. Instrumentação manual, porque a instrumentação automática do Node depende de hooks de `require` que não funcionam de forma confiável no Bun.

```
POST /wagering/transactions            (continua um traceparent recebido, se houver)
└── db.transaction
    └── wallet.lock                    (SELECT ... FOR UPDATE: tempo de espera pelo lock)
publish WalletBalanceChanged           (worker da outbox, mesmo trace da requisição)
process wager-transactions             (consumidor SQS, continua o traceparent da mensagem)
└── db.transaction
    └── wallet.lock
```

O contexto do trace é gravado na outbox na mesma transação SQL do evento (coluna `headers`, preenchida pela infraestrutura; para o domínio é um metadado de transporte opaco) e enviado como atributo `traceparent` da mensagem. Assim, a publicação assíncrona aparece no mesmo trace da requisição que a originou. As respostas HTTP trazem `x-trace-id`.

## Reconciliação

**Sob demanda** (`POST /wallets/:id/reconciliation`): compara, numa única consulta, o saldo armazenado, a soma do ledger da wallet e o saldo da conta do jogador no razão (`journalBalance`).

**Periódica** (`src/application/maintenance/reconcile-all-wallets.ts`, a cada `RECONCILIATION_INTERVAL_MS`, padrão 5 min): a mesma comparação para todas as wallets.

- Lotes por keyset (`id > último`, 500 por vez), todos dentro de uma única transação `REPEATABLE READ READ ONLY`. Todos os lotes enxergam o mesmo snapshot, e nenhuma escrita é bloqueada.
- `pg_try_advisory_xact_lock` garante uma varredura por vez no cluster: as outras instâncias pulam a rodada em vez de esperar. O lock é liberado no fim da transação, inclusive se o processo morrer.

Em ambos os casos, divergências **não** são corrigidas: viram log de erro, métrica e o alerta `WalletBalanceDivergence`. Corrigir automaticamente esconderia o bug que causou a divergência e reescreveria um histórico financeiro que precisa ser auditável. Com os triggers deferidos do banco, uma divergência só é possível por intervenção manual no banco; a reconciliação é a rede de segurança para esse caso.

## Alertas

Regras do Prometheus em `docker/observability/alerts.yml`, com testes unitários em `alerts.test.yml` executados por `promtool test rules` no CI. Todas as expressões agregam entre instâncias (`max`/`sum`), então um alerta dispara uma vez por condição, não uma vez por réplica. Cada alerta tem `runbook_url` apontando para a seção correspondente de [runbooks/alerts.md](../runbooks/alerts.md).

| Alerta                    | Condição                                                       | Severidade |
| ------------------------- | -------------------------------------------------------------- | ---------- |
| `WalletBalanceDivergence` | a última reconciliação completa achou alguma wallet divergente | critical   |
| `ReconciliationStale`     | nenhuma reconciliação completa há mais de 30 min               | warning    |
| `OutboxLagHigh`           | evento mais antigo não publicado com mais de 30 s, por 2 min   | warning    |
| `OutboxStuck`             | outbox sem drenar há mais de 5 min                             | critical   |
| `OutboxPublishFailures`   | publicações da outbox falhando por 5 min                       | warning    |
| `DeadLetterQueueNotEmpty` | mensagens na DLQ                                               | warning    |
| `SqsRetriesSpiking`       | mais de 1 mensagem/s devolvida à fila por falha transitória    | warning    |
| `WageringInstanceDown`    | instância sem responder ao scrape por 1 min                    | critical   |
| `WagerLatencyHigh`        | p99 do processamento acima de 1 s                              | warning    |
| `WalletLockContention`    | p95 da espera pelo lock da wallet acima de 500 ms              | warning    |
| `RejectionRateHigh`       | mais de 20% das transações rejeitadas por 10 min               | warning    |

## Health checks

`/health/live` (processo vivo) e `/health/ready` (`SELECT 1` no Postgres, `GetQueueAttributes` no SQS e, com autenticação ligada, o JWKS do Keycloak; timeout de 2 s por verificação). O compose usa o `ready` como healthcheck das réplicas.
