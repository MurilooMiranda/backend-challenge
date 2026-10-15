import type { Subprocess } from 'bun';
import { TEST_DATABASE_URL } from './database';
import type { TestQueues } from './sqs';

export interface AppInstance {
  port: number;
  url: string;
  process: Subprocess;
}

export async function waitUntil(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition().catch(() => false)) {
      return;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

export async function startInstance(
  port: number,
  queues: TestQueues,
  databaseUrl: string = TEST_DATABASE_URL,
  logFile?: string,
): Promise<AppInstance> {
  const child = Bun.spawn([process.execPath, 'src/main.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      SQS_TRANSACTIONS_QUEUE_URL: queues.queueUrl,
      SQS_TRANSACTIONS_DLQ_URL: queues.dlqUrl,
      SQS_EVENTS_QUEUE_URL: queues.eventsUrl,
      WORKERS_ENABLED: 'true',
      RUN_MIGRATIONS: 'false',
      SQS_WAIT_TIME_SECONDS: '1',
      SQS_RETRY_BASE_SECONDS: '0',
      OUTBOX_POLL_INTERVAL_MS: '100',
      PENDING_REFERENCE_POLL_INTERVAL_MS: '250',
      LOG_LEVEL: logFile ? 'warn' : 'error',
    },
    stdout: logFile ? Bun.file(logFile) : 'ignore',
    stderr: logFile ? Bun.file(`${logFile}.err`) : 'ignore',
  });
  const url = `http://localhost:${port}`;
  await waitUntil(async () => (await fetch(`${url}/health/ready`)).ok, 30_000);
  return { port, url, process: child };
}

export async function stopInstance(instance: AppInstance): Promise<void> {
  instance.process.kill();
  await instance.process.exited;
}
