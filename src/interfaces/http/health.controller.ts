import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Response } from 'express';
import { SQS_CLIENT, type SqsQueues, readSqsQueues } from '@/infrastructure/messaging/sqs';
import { MIKRO_ORM } from '@/infrastructure/persistence/orm.provider';

type CheckStatus = 'up' | 'down';

const CHECK_TIMEOUT_MS = 2_000;

@Controller('health')
export class HealthController {
  private readonly queues: SqsQueues = readSqsQueues();

  constructor(
    @Inject(MIKRO_ORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response) {
    const [postgres, sqs] = await Promise.all([
      this.check(() => this.orm.em.fork().execute('SELECT 1')),
      this.check(() =>
        this.sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: this.queues.transactionsQueueUrl,
            AttributeNames: ['QueueArn'],
          }),
        ),
      ),
    ]);
    const ready = postgres === 'up' && sqs === 'up';
    response.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ready ? 'ok' : 'unavailable', checks: { postgres, sqs } };
  }

  private async check(probe: () => Promise<unknown>): Promise<CheckStatus> {
    try {
      await Promise.race([
        probe(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS),
        ),
      ]);
      return 'up';
    } catch {
      return 'down';
    }
  }
}
