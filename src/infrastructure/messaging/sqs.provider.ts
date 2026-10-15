import type { SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { SQS_CLIENT, createSqsClient } from './sqs';

export const sqsClientProvider: Provider = {
  provide: SQS_CLIENT,
  useFactory: (): SQSClient => createSqsClient(),
};

@Injectable()
export class SqsShutdown implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}
