import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { PublishOutboxEvents } from '@/application/messaging/publish-outbox-events';
import { RetryPendingReferences } from '@/application/wagering/retry-pending-references';
import { PollingWorker } from '@/infrastructure/workers/polling-worker';
import { WagerTransactionConsumer } from '../sqs/wager-transaction-consumer';

const OUTBOX_BATCH_SIZE = 100;
const PENDING_REFERENCE_BATCH_SIZE = 50;

@Injectable()
export class BackgroundWorkers implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(BackgroundWorkers.name);
  private readonly outboxWorker: PollingWorker;
  private readonly pendingReferenceWorker: PollingWorker;

  constructor(
    @Inject(PublishOutboxEvents) publishOutbox: PublishOutboxEvents,
    @Inject(RetryPendingReferences) retryPendingReferences: RetryPendingReferences,
    @Inject(WagerTransactionConsumer) private readonly consumer: WagerTransactionConsumer,
  ) {
    this.outboxWorker = new PollingWorker(
      'OutboxPublisher',
      async () => {
        const { published } = await publishOutbox.execute(OUTBOX_BATCH_SIZE);
        return published > 0;
      },
      Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 500),
    );
    this.pendingReferenceWorker = new PollingWorker(
      'PendingReferenceWorker',
      async () => {
        const { checked } = await retryPendingReferences.execute(PENDING_REFERENCE_BATCH_SIZE);
        return checked === PENDING_REFERENCE_BATCH_SIZE;
      },
      Number(process.env.PENDING_REFERENCE_POLL_INTERVAL_MS ?? 1_000),
    );
  }

  onApplicationBootstrap(): void {
    if (process.env.WORKERS_ENABLED === 'false') {
      this.logger.log('background workers disabled');
      return;
    }
    this.outboxWorker.start();
    this.pendingReferenceWorker.start();
    this.consumer.start();
    this.logger.log('background workers started');
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`stopping background workers (${signal ?? 'shutdown'})`);
    await Promise.all([
      this.consumer.stop(),
      this.outboxWorker.stop(),
      this.pendingReferenceWorker.stop(),
    ]);
    this.logger.log('background workers stopped');
  }
}
