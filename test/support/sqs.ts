import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  type SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';

export interface TestQueues {
  queueUrl: string;
  dlqUrl: string;
  eventsUrl: string;
  cleanup: () => Promise<void>;
}

const ENDPOINT = process.env.AWS_ENDPOINT ?? 'http://localhost:4566';
const ACCOUNT = '000000000000';

const urlFor = (name: string) => `${ENDPOINT}/${ACCOUNT}/${name}`;

export async function createTestQueues(sqs: SQSClient, maxReceiveCount = 5): Promise<TestQueues> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const names = {
    queue: `test-${suffix}.fifo`,
    dlq: `test-${suffix}-dlq.fifo`,
    events: `test-${suffix}-events.fifo`,
  };

  await sqs.send(
    new CreateQueueCommand({ QueueName: names.dlq, Attributes: { FifoQueue: 'true' } }),
  );
  const dlqAttributes = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: urlFor(names.dlq), AttributeNames: ['QueueArn'] }),
  );
  await sqs.send(
    new CreateQueueCommand({
      QueueName: names.queue,
      Attributes: {
        FifoQueue: 'true',
        VisibilityTimeout: '30',
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqAttributes.Attributes?.QueueArn,
          maxReceiveCount: String(maxReceiveCount),
        }),
      },
    }),
  );
  await sqs.send(
    new CreateQueueCommand({ QueueName: names.events, Attributes: { FifoQueue: 'true' } }),
  );

  return {
    queueUrl: urlFor(names.queue),
    dlqUrl: urlFor(names.dlq),
    eventsUrl: urlFor(names.events),
    cleanup: async () => {
      await Promise.all(
        Object.values(names).map((name) =>
          sqs.send(new DeleteQueueCommand({ QueueUrl: urlFor(name) })).catch(() => undefined),
        ),
      );
    },
  };
}

export async function sendRaw(
  sqs: SQSClient,
  queueUrl: string,
  body: string,
  groupId: string,
  deduplicationId: string = crypto.randomUUID(),
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: deduplicationId,
    }),
  );
}

export async function drain(sqs: SQSClient, queueUrl: string): Promise<Message[]> {
  const received: Message[] = [];
  for (let i = 0; i < 10; i++) {
    const response = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 30,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['MessageGroupId'],
      }),
    );
    const messages = response.Messages ?? [];
    if (messages.length === 0) {
      break;
    }
    received.push(...messages);
  }
  return received;
}

export function wagerMessage(
  data: Record<string, unknown>,
  messageId: string = `msg-${crypto.randomUUID()}`,
): { messageId: string; body: string } {
  return {
    messageId,
    body: JSON.stringify({
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data,
    }),
  };
}
