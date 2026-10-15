import type { summarize } from './stats';

type Summary = ReturnType<typeof summarize>;

export interface LoadReport {
  generatedAt: string;
  config: Record<string, unknown>;
  environment: { os: string; cpu: string; memoryGb: number; bun: string; postgres: string };
  http: {
    seconds: number;
    requests: number;
    throughput: number;
    latency: Summary;
    latencyByKind: Record<string, Summary>;
    replayLatency: Summary;
    statuses: Record<string, number>;
    errors: number;
    errorRate: number;
  };
  server: {
    processingP95Ms: number;
    processingP99Ms: number;
    lockWaitP50Ms: number;
    lockWaitP95Ms: number;
    lockWaitP99Ms: number;
    lockConflicts: number;
    duplicates: number;
    sqsRetries: number;
    deadLettered: number;
    outboxFailed: number;
  };
  outbox: {
    maxPending: number;
    maxLagSeconds: number;
    lagP95Seconds: number;
    drainSecondsAfterHttp: number;
  };
  sqs: { messages: number; enqueueSeconds: number; totalSeconds: number; throughput: number };
  correctness: {
    wallets: number;
    divergentWallets: number;
    ledgerEntries: number;
    transactions: number;
    journalEntries: number;
    unbalancedJournalEntries: number;
    journalDivergentWallets: number;
    journalDebits: string;
    journalCredits: string;
    statuses: { status: string; failure_code: string | null; n: number }[];
  };
}

const ms = (value: number) =>
  Number.isFinite(value) ? `${value.toFixed(1)} ms` : '> maior bucket';
const s = (value: number) => `${value.toFixed(2)} s`;

function latencyRow(label: string, summary: Summary): string {
  return `| ${label} | ${summary.count} | ${ms(summary.p50)} | ${ms(summary.p95)} | ${ms(summary.p99)} | ${ms(summary.max)} |`;
}

export function renderReport(report: LoadReport): string {
  const { http, server, outbox, sqs, correctness, environment, config } = report;
  return `# Resultado do teste de carga

Gerado em ${report.generatedAt} por \`bun run test:load\`.

## Ambiente

| Item | Valor |
|---|---|
| Sistema | ${environment.os} |
| CPU | ${environment.cpu} |
| Memória | ${environment.memoryGb} GB |
| Bun | ${environment.bun} |
| PostgreSQL | ${environment.postgres} |

## Parâmetros

| Parâmetro | Valor |
|---|---|
${Object.entries(config)
  .filter(([key]) => key !== 'databaseUrl')
  .map(([key, value]) => `| ${key} | ${value} |`)
  .join('\n')}

## HTTP

| Métrica | Valor |
|---|---|
| Duração | ${s(http.seconds)} |
| Requisições | ${http.requests} |
| Throughput | ${http.throughput.toFixed(1)} req/s |
| Erros (status fora de 200/201/202/422) | ${http.errors} (${(http.errorRate * 100).toFixed(2)}%) |
| Status | ${Object.entries(http.statuses)
    .map(([status, count]) => `${status}: ${count}`)
    .join(', ')} |

Latência observada pelo cliente:

| Tipo | Amostras | p50 | p95 | p99 | máx |
|---|---|---|---|---|---|
${latencyRow('todas', http.latency)}
${Object.entries(http.latencyByKind)
  .map(([kind, summary]) => latencyRow(kind, summary))
  .join('\n')}
${latencyRow('replays', http.replayLatency)}

## Servidor (somado das instâncias)

| Métrica | Valor |
|---|---|
| Processamento p95 / p99 (histograma, interpolado) | ${ms(server.processingP95Ms)} / ${ms(server.processingP99Ms)} |
| Espera do lock da wallet p50 / p95 / p99 | ${ms(server.lockWaitP50Ms)} / ${ms(server.lockWaitP95Ms)} / ${ms(server.lockWaitP99Ms)} |
| Conflitos de concorrência resolvidos com retry | ${server.lockConflicts} |
| Duplicatas respondidas como replay | ${server.duplicates} |
| Retries de mensagens SQS | ${server.sqsRetries} |
| Mensagens enviadas à DLQ | ${server.deadLettered} |
| Falhas de publicação da outbox | ${server.outboxFailed} |

## Outbox

| Métrica | Valor |
|---|---|
| Máximo de eventos pendentes | ${outbox.maxPending} |
| Lag máximo (evento pendente mais antigo) | ${s(outbox.maxLagSeconds)} |
| Lag p95 (amostras de 1 s) | ${s(outbox.lagP95Seconds)} |
| Tempo para zerar a outbox após a carga HTTP | ${s(outbox.drainSecondsAfterHttp)} |

## SQS

| Métrica | Valor |
|---|---|
| Mensagens | ${sqs.messages} |
| Tempo de envio | ${s(sqs.enqueueSeconds)} |
| Tempo até a última ser aplicada | ${s(sqs.totalSeconds)} |
| Throughput de consumo | ${sqs.throughput.toFixed(1)} msg/s |

## Correção após a carga

| Verificação | Valor |
|---|---|
| Wallets | ${correctness.wallets} |
| Wallets com saldo diferente do ledger reconstruído | **${correctness.divergentWallets}** |
| Lançamentos no ledger | ${correctness.ledgerEntries} |
| Transações | ${correctness.transactions} |
| Lançamentos contábeis (partidas dobradas) | ${correctness.journalEntries} |
| Lançamentos contábeis desbalanceados | **${correctness.unbalancedJournalEntries}** |
| Wallets com saldo diferente da conta contábil do jogador | **${correctness.journalDivergentWallets}** |
| Total de débitos / créditos no razão | ${correctness.journalDebits} / ${correctness.journalCredits} |

| Status | failureCode | Quantidade |
|---|---|---|
${correctness.statuses.map((row) => `| ${row.status} | ${row.failure_code ?? '—'} | ${row.n} |`).join('\n')}
`;
}
