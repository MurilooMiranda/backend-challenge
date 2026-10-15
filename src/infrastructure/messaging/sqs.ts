import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishOutcome } from '@/application/ports';
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
  readonly maxBatchSize = 10;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publishBatch(messages: OutboxMessage[]): Promise<PublishOutcome[]> {
    if (messages.length === 0) {
      return [];
    }
    try {
      const response = await this.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: this.queueUrl,
          Entries: messages.map((message, index) => ({
            Id: String(index),
            MessageBody: JSON.stringify(message.payload),
            MessageGroupId: message.aggregateId,
            MessageDeduplicationId: message.id,
            MessageAttributes: {
              eventType: { DataType: 'String', StringValue: message.eventType },
            },
          })),
        }),
      );
      const failures = new Map(
        (response.Failed ?? []).map((failure) => [
          failure.Id,
          failure.Message ?? failure.Code ?? 'publish failed',
        ]),
      );
      return messages.map((message, index) => {
        const error = failures.get(String(index));
        return error === undefined ? { messageId: message.id } : { messageId: message.id, error };
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return messages.map((message) => ({ messageId: message.id, error: reason }));
    }
  }
}
