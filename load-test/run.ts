import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { createSqsClient } from '@/infrastructure/messaging/sqs';
import { createOrmConfig } from '@/infrastructure/persistence/mikro-orm.config';
import {
  type AppInstance,
  startInstance,
  stopInstance,
  waitUntil,
} from '../test/support/instances';
import { createTestQueues } from '../test/support/sqs';
import { histogramQuantile, parsePrometheus, summarize, sumMetric } from './stats';
import { type LoadWallet, type WagerRequest, Workload } from './workload';
import { type LoadReport, renderReport } from './report';

const env = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

const config = {
  instances: env('LOAD_INSTANCES', 3),
  durationSeconds: env('LOAD_DURATION_SECONDS', 30),
  concurrency: env('LOAD_CONCURRENCY', 48),
  wallets: env('LOAD_WALLETS', 200),
  hotWallets: env('LOAD_HOT_WALLETS', 4),
  hotShare: env('LOAD_HOT_SHARE', 0.2),
  sqsMessages: env('LOAD_SQS_MESSAGES', 2000),
  databaseUrl:
    process.env.LOAD_DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering_load',
};

const OK_STATUSES = new Set([200, 201, 202, 422]);
const REQUEST_TIMEOUT_MS = 10_000;

interface HttpSample {
  kind: string;
  replay: boolean;
  status: number;
  ms: number;
}

async function ensureDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const name = target.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const orm = await MikroORM.init({
    clientUrl: admin.toString(),
    entities: [],
    discovery: { warnWhenNoEntities: false },
  });
  try {
    const rows = await orm.em.execute('SELECT 1 FROM pg_database WHERE datname = ?', [name]);
    if (rows.length === 0) {
      await orm.em.execute(`CREATE DATABASE "${name}"`);
    }
  } finally {
    await orm.close();
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
) {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await work(items[index]!, index);
      }
    }),
  );
  return results;
}

async function outboxSnapshot(orm: MikroORM) {
  const [row] = await orm.em.fork().execute<{ pending: number; lag: number | null }[]>(
    `SELECT count(*)::int AS pending,
            EXTRACT(EPOCH FROM (now() - min(occurred_at)))::float AS lag
       FROM outbox_messages
      WHERE published_at IS NULL`,
  );
  return { pending: row?.pending ?? 0, lagSeconds: row?.lag ?? 0 };
}

async function main(): Promise<void> {
  console.log('load test configuration', config);
  await ensureDatabase(config.databaseUrl);
  const orm = await MikroORM.init(createOrmConfig(config.databaseUrl));
  await orm.migrator.up();
  await orm.em.execute(
    'TRUNCATE journal_postings, journal_entries, ledger_accounts, wallet_ledger_entries, wager_transactions, wallets, inbox_messages, outbox_messages RESTART IDENTITY CASCADE',
  );

  const sqs = createSqsClient();
  const queues = await createTestQueues(sqs);
  const instances: AppInstance[] = [];

  try {
    console.log(`starting ${config.instances} instances`);
    instances.push(
      ...(await Promise.all(
        Array.from({ length: config.instances }, (_, i) =>
          startInstance(
            4201 + i,
            queues,
            config.databaseUrl,
            `load-test/results/instance-${i + 1}.log`,
          ),
        ),
      )),
    );
    const target = (i: number) => instances[i % instances.length]!.url;

    const walletSpecs = Array.from({ length: config.wallets + config.hotWallets }, (_, i) => ({
      hot: i < config.hotWallets,
    }));
    const wallets = await mapLimit(walletSpecs, 20, async (spec, i): Promise<LoadWallet> => {
      const response = await fetch(`${target(i)}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          playerId: crypto.randomUUID(),
          initialBalance: { amount: '1000000.00', currency: 'BRL' },
        }),
      });
      const body = (await response.json()) as { id: string; playerId: string };
      return { id: body.id, playerId: body.playerId, hot: spec.hot, openBets: [] };
    });
    const workload = new Workload(
      wallets.filter((w) => !w.hot),
      wallets.filter((w) => w.hot),
      config.hotShare,
    );

    console.log(`http phase: ${config.concurrency} virtual users for ${config.durationSeconds}s`);
    const samples: HttpSample[] = [];
    const outboxSamples: { pending: number; lagSeconds: number }[] = [];
    const sampler = setInterval(() => {
      outboxSnapshot(orm)
        .then((snapshot) => outboxSamples.push(snapshot))
        .catch(() => undefined);
    }, 1_000);

    const httpStartedAt = performance.now();
    const deadline = httpStartedAt + config.durationSeconds * 1_000;
    let requestCounter = 0;
    let timeouts = 0;
    let stuckSnapshot: unknown[] = [];
    await Promise.all(
      Array.from({ length: config.concurrency }, async () => {
        while (performance.now() < deadline) {
          const request: WagerRequest = workload.next();
          const url = target(requestCounter++);
          const startedAt = performance.now();
          let status = 0;
          let resultStatus: string | undefined;
          try {
            const response = await fetch(`${url}/wagering/transactions`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'Idempotency-Key': request.idempotencyKey,
              },
              body: JSON.stringify(request.body),
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            status = response.status;
            resultStatus = ((await response.json()) as { status?: string }).status;
          } catch {
            status = 0;
            timeouts += 1;
            if (timeouts === 1) {
              stuckSnapshot = await orm.em
                .fork()
                .execute(
                  `SELECT pid, state, wait_event_type, wait_event, now() - xact_start AS xact_age, left(query, 160) AS query
                     FROM pg_stat_activity
                    WHERE datname = current_database() AND state <> 'idle' AND pid <> pg_backend_pid()`,
                )
                .catch((error: Error) => [{ error: error.message }]);
            }
          }
          samples.push({
            kind: request.kind,
            replay: request.replay,
            status,
            ms: performance.now() - startedAt,
          });
          workload.onResult(request, resultStatus);
        }
      }),
    );
    const httpSeconds = (performance.now() - httpStartedAt) / 1_000;
    clearInterval(sampler);

    const drainStartedAt = performance.now();
    await waitUntil(async () => (await outboxSnapshot(orm)).pending === 0, 120_000, 250);
    const outboxDrainSeconds = (performance.now() - drainStartedAt) / 1_000;

    console.log(`sqs phase: ${config.sqsMessages} messages`);
    const normal = wallets.filter((w) => !w.hot);
    const messages = Array.from({ length: config.sqsMessages }, (_, i) => {
      const wallet = normal[i % normal.length]!;
      const externalTransactionId = `sqs-${i}-${crypto.randomUUID().slice(0, 8)}`;
      const messageId = `msg-${externalTransactionId}`;
      return {
        wallet,
        messageId,
        body: JSON.stringify({
          messageId,
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: {
            providerId: 'provider-load',
            externalTransactionId,
            idempotencyKey: `provider-load:${externalTransactionId}`,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: 'round-sqs',
            gameId: 'fortune-chimp',
            kind: 'BET',
            money: { amount: '1.00', currency: 'BRL' },
          },
        }),
      };
    });
    const batches = Array.from({ length: Math.ceil(messages.length / 10) }, (_, i) =>
      messages.slice(i * 10, i * 10 + 10),
    );
    const sqsStartedAt = performance.now();
    await mapLimit(batches, 20, (batch) =>
      sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: queues.queueUrl,
          Entries: batch.map((message, index) => ({
            Id: String(index),
            MessageBody: message.body,
            MessageGroupId: message.wallet.id,
            MessageDeduplicationId: message.messageId,
          })),
        }),
      ),
    );
    const sqsEnqueueSeconds = (performance.now() - sqsStartedAt) / 1_000;
    await waitUntil(
      async () => {
        const [row] = await orm.em
          .fork()
          .execute<{ n: number }[]>('SELECT count(*)::int AS n FROM inbox_messages');
        return (row?.n ?? 0) >= config.sqsMessages;
      },
      300_000,
      250,
    );
    const sqsSeconds = (performance.now() - sqsStartedAt) / 1_000;
    await waitUntil(async () => (await outboxSnapshot(orm)).pending === 0, 120_000, 250);

    const scraped = parsePrometheus(
      (
        await Promise.all(instances.map(async (i) => (await fetch(`${i.url}/metrics`)).text()))
      ).join('\n'),
    );

    const [correctness] = await orm.em
      .fork()
      .execute<{ wallets: number; divergent: number; entries: number; transactions: number }[]>(
        `SELECT count(*)::int AS wallets,
              count(*) FILTER (WHERE w.balance <> COALESCE(l.rebuilt, 0))::int AS divergent,
              COALESCE(sum(l.entries), 0)::int AS entries,
              (SELECT count(*)::int FROM wager_transactions) AS transactions
         FROM wallets w
         LEFT JOIN (
           SELECT wallet_id,
                  sum(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END) AS rebuilt,
                  count(*) AS entries
             FROM wallet_ledger_entries
            GROUP BY wallet_id
         ) l ON l.wallet_id = w.id`,
      );
    const [journal] = await orm.em.fork().execute<
      {
        entries: number;
        unbalanced: number;
        journal_divergent: number;
        debits: string;
        credits: string;
      }[]
    >(
      `SELECT (SELECT count(*)::int FROM journal_entries) AS entries,
              (SELECT count(*)::int
                 FROM (SELECT journal_entry_id
                         FROM journal_postings
                        GROUP BY journal_entry_id
                       HAVING sum(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END) <> 0) u) AS unbalanced,
              (SELECT count(*)::int
                 FROM wallets w
                 LEFT JOIN ledger_accounts a ON a.wallet_id = w.id
                 LEFT JOIN LATERAL (
                   SELECT COALESCE(sum(CASE WHEN p.direction = 'CREDIT' THEN p.amount ELSE -p.amount END), 0) AS balance
                     FROM journal_postings p
                    WHERE p.account_code = a.code
                 ) j ON true
                WHERE w.balance <> COALESCE(j.balance, 0)) AS journal_divergent,
              (SELECT COALESCE(sum(amount) FILTER (WHERE direction = 'DEBIT'), 0)::text FROM journal_postings) AS debits,
              (SELECT COALESCE(sum(amount) FILTER (WHERE direction = 'CREDIT'), 0)::text FROM journal_postings) AS credits`,
    );
    const statusRows = await orm.em
      .fork()
      .execute<{ status: string; failure_code: string | null; n: number }[]>(
        `SELECT status, failure_code, count(*)::int AS n
           FROM wager_transactions
          WHERE kind <> 'OPENING'
          GROUP BY status, failure_code
          ORDER BY n DESC`,
      );
    const [pgVersion] = await orm.em.execute<{ version: string }[]>(
      "SELECT current_setting('server_version') AS version",
    );

    const errors = samples.filter((s) => !OK_STATUSES.has(s.status));
    const report: LoadReport = {
      generatedAt: new Date().toISOString(),
      config,
      environment: {
        os: `${os.type()} ${os.release()} (${os.arch()})`,
        cpu: `${os.cpus()[0]?.model ?? 'unknown'} x${os.cpus().length}`,
        memoryGb: Math.round(os.totalmem() / 1024 ** 3),
        bun: Bun.version,
        postgres: pgVersion?.version ?? 'unknown',
      },
      http: {
        seconds: httpSeconds,
        requests: samples.length,
        throughput: samples.length / httpSeconds,
        latency: summarize(samples.map((s) => s.ms)),
        latencyByKind: Object.fromEntries(
          ['BET', 'WIN', 'LOSS', 'REFUND'].map((kind) => [
            kind,
            summarize(samples.filter((s) => s.kind === kind && !s.replay).map((s) => s.ms)),
          ]),
        ),
        replayLatency: summarize(samples.filter((s) => s.replay).map((s) => s.ms)),
        statuses: Object.fromEntries(
          [...new Set(samples.map((s) => s.status))]
            .sort()
            .map((status) => [String(status), samples.filter((s) => s.status === status).length]),
        ),
        errors: errors.length,
        errorRate: samples.length ? errors.length / samples.length : 0,
      },
      server: {
        processingP95Ms:
          histogramQuantile(scraped, 'wager_processing_duration_seconds', 0.95, {
            channel: 'http',
          }) * 1_000,
        processingP99Ms:
          histogramQuantile(scraped, 'wager_processing_duration_seconds', 0.99, {
            channel: 'http',
          }) * 1_000,
        lockWaitP50Ms: histogramQuantile(scraped, 'wallet_lock_wait_seconds', 0.5) * 1_000,
        lockWaitP95Ms: histogramQuantile(scraped, 'wallet_lock_wait_seconds', 0.95) * 1_000,
        lockWaitP99Ms: histogramQuantile(scraped, 'wallet_lock_wait_seconds', 0.99) * 1_000,
        lockConflicts: sumMetric(scraped, 'wallet_lock_conflicts_total'),
        duplicates: sumMetric(scraped, 'wager_duplicates_total'),
        sqsRetries: sumMetric(scraped, 'sqs_message_retries_total'),
        deadLettered: sumMetric(scraped, 'sqs_messages_dead_lettered_total'),
        outboxFailed: sumMetric(scraped, 'outbox_messages_total', { result: 'failed' }),
      },
      outbox: {
        maxPending: Math.max(0, ...outboxSamples.map((s) => s.pending)),
        maxLagSeconds: Math.max(0, ...outboxSamples.map((s) => s.lagSeconds)),
        lagP95Seconds: summarize(outboxSamples.map((s) => s.lagSeconds)).p95,
        drainSecondsAfterHttp: outboxDrainSeconds,
      },
      sqs: {
        messages: config.sqsMessages,
        enqueueSeconds: sqsEnqueueSeconds,
        totalSeconds: sqsSeconds,
        throughput: config.sqsMessages / sqsSeconds,
      },
      correctness: {
        wallets: correctness?.wallets ?? 0,
        divergentWallets: correctness?.divergent ?? -1,
        ledgerEntries: correctness?.entries ?? 0,
        transactions: correctness?.transactions ?? 0,
        journalEntries: journal?.entries ?? 0,
        unbalancedJournalEntries: journal?.unbalanced ?? -1,
        journalDivergentWallets: journal?.journal_divergent ?? -1,
        journalDebits: journal?.debits ?? '?',
        journalCredits: journal?.credits ?? '?',
        statuses: statusRows,
      },
    };

    if (stuckSnapshot.length > 0) {
      writeFileSync(
        'load-test/results/stuck-activity.json',
        `${JSON.stringify(stuckSnapshot, null, 2)}
`,
      );
    }
    const markdown = renderReport(report);
    mkdirSync('load-test/results', { recursive: true });
    writeFileSync('load-test/results/latest.md', markdown);
    writeFileSync('load-test/results/latest.json', `${JSON.stringify(report, null, 2)}\n`);
    console.log(markdown);

    if (
      report.correctness.divergentWallets !== 0 ||
      report.correctness.unbalancedJournalEntries !== 0 ||
      report.correctness.journalDivergentWallets !== 0
    ) {
      process.exitCode = 1;
    }
  } finally {
    await Promise.all(instances.map(stopInstance));
    await queues.cleanup();
    sqs.destroy();
    await orm.close();
  }
}

await main();
