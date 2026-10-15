import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { EventPublisher } from '@/application/ports';
import type { OutboxMessage } from '@/domain/messaging/outbox-message';

export const SQS_CLIENT = Symbol('SQSClient');

export interface SqsQueues {
  transactionsQueueUrl: string;
  transactionsDlqUrl: string;
  eventsQueueUrl: string;
}

export function createSqsClient(): SQSClient {
  return new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    ...(process.env.AWS_ENDPOINT ? { endpoint: process.env.AWS_ENDPOINT } : {}),
  });
}

export function readSqsQueues(): SqsQueues {
  const required = (name: string) => {
    const value = process.env[name];
    if (!value) {
      throw new Error(`${name} is not set`);
    }
    return value;
  };
  return {
    transactionsQueueUrl: required('SQS_TRANSACTIONS_QUEUE_URL'),
    transactionsDlqUrl: required('SQS_TRANSACTIONS_DLQ_URL'),
    eventsQueueUrl: required('SQS_EVENTS_QUEUE_URL'),
  };
}

export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: message.eventType },
        },
      }),
    );
  }
}
