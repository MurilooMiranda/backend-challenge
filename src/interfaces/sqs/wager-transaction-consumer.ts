import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import {
  IdempotencyConflictError,
  InboxPayloadMismatchError,
  InvalidCommandError,
  WalletNotFoundError,
} from '@/application/errors';
import { type ConsumeOutcome, type Telemetry, noopTelemetry } from '@/application/telemetry';
import type { ProcessWagerTransaction } from '@/application/wagering/process-wager-transaction';
import { DomainError } from '@/domain/shared/domain-error';
import { addLogContext, runWithLogContext } from '@/infrastructure/observability/log-context';
import {
  RequestValidationError,
  type WagerMessage,
  parseBody,
  wagerMessageSchema,
} from '../http/schemas';

export interface WagerConsumerOptions {
  queueUrl: string;
  deadLetterQueueUrl: string;
  consumerName: string;
  maxMessages: number;
  pollers?: number;
  waitTimeSeconds: number;
  retryBaseSeconds: number;
  maxRetrySeconds: number;
}

export type { ConsumeOutcome };

interface HandledMessage {
  outcome: ConsumeOutcome;
  messageId: string;
  failureCode?: string;
}

export function defaultConsumerOptions(
  queueUrl: string,
  deadLetterQueueUrl: string,
): WagerConsumerOptions {
  return {
    queueUrl,
    deadLetterQueueUrl,
    consumerName: 'wager-transactions-consumer',
    maxMessages: 10,
    pollers: Number(process.env.SQS_CONSUMER_POLLERS ?? 4),
    waitTimeSeconds: Number(process.env.SQS_WAIT_TIME_SECONDS ?? 20),
    retryBaseSeconds: Number(process.env.SQS_RETRY_BASE_SECONDS ?? 2),
    maxRetrySeconds: 60,
  };
}

export function isPermanentFailure(error: unknown): boolean {
  return (
    error instanceof RequestValidationError ||
    error instanceof DomainError ||
    error instanceof InvalidCommandError ||
    error instanceof IdempotencyConflictError ||
    error instanceof InboxPayloadMismatchError ||
    error instanceof WalletNotFoundError
  );
}

export class WagerTransactionConsumer {
  private readonly logger = new Logger(WagerTransactionConsumer.name);
  private running = false;
  private loops: Promise<void>[] = [];
  private readonly receiveAborts = new Set<AbortController>();

  constructor(
    private readonly sqs: SQSClient,
    private readonly processWager: ProcessWagerTransaction,
    private readonly options: WagerConsumerOptions,
    private readonly telemetry: Telemetry = noopTelemetry,
  ) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loops = Array.from({ length: Math.max(1, this.options.pollers ?? 1) }, () => this.run());
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const abort of this.receiveAborts) {
      abort.abort();
    }
    await Promise.all(this.loops);
    this.loops = [];
  }

  async pollOnce(): Promise<ConsumeOutcome[]> {
    const abort = new AbortController();
    this.receiveAborts.add(abort);
    const response = await this.sqs
      .send(
        new ReceiveMessageCommand({
          QueueUrl: this.options.queueUrl,
          MaxNumberOfMessages: this.options.maxMessages,
          WaitTimeSeconds: this.options.waitTimeSeconds,
          MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        }),
        { abortSignal: abort.signal },
      )
      .finally(() => this.receiveAborts.delete(abort));
    const messages = response.Messages ?? [];

    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? '';
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }

    const outcomes = await Promise.all(
      [...groups.values()].map((group) => this.consumeGroup(group)),
    );
    return outcomes.flat();
  }

  async consume(message: Message): Promise<ConsumeOutcome> {
    return runWithLogContext({ sqsMessageId: message.MessageId }, async () => {
      const handled = await this.handle(message);
      this.telemetry.messageConsumed(handled);
      return handled.outcome;
    });
  }

  private async handle(message: Message): Promise<HandledMessage> {
    let parsed: WagerMessage;
    try {
      parsed = parseBody(wagerMessageSchema, JSON.parse(message.Body ?? ''));
    } catch (error) {
      await this.deadLetter(message, 'INVALID_MESSAGE', (error as Error).message);
      return {
        outcome: 'dead-lettered',
        messageId: message.MessageId ?? 'unknown',
        failureCode: 'INVALID_MESSAGE',
      };
    }

    addLogContext({
      messageId: parsed.messageId,
      correlationId: parsed.messageId,
      walletId: parsed.data.walletId,
      providerId: parsed.data.providerId,
    });

    try {
      const result = await this.processWager.execute({
        ...parsed.data,
        correlationId: parsed.messageId,
        causationId: parsed.messageId,
        inbox: { consumerName: this.options.consumerName, messageId: parsed.messageId },
        channel: 'sqs',
      });
      addLogContext({ transactionId: result.transactionId });
      await this.ack(message);
      return { outcome: 'acked', messageId: parsed.messageId };
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'UNKNOWN';
      if (isPermanentFailure(error)) {
        await this.deadLetter(message, code, (error as Error).message);
        return { outcome: 'dead-lettered', messageId: parsed.messageId, failureCode: code };
      }
      await this.delay(message);
      return { outcome: 'retry', messageId: parsed.messageId, failureCode: code };
    }
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (!this.running) {
          break;
        }
        this.logger.error(`poll failed: ${(error as Error).message}`);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  private async consumeGroup(messages: Message[]): Promise<ConsumeOutcome[]> {
    const outcomes: ConsumeOutcome[] = [];
    for (const [index, message] of messages.entries()) {
      const outcome = await this.consume(message);
      outcomes.push(outcome);
      if (outcome === 'retry') {
        await Promise.all(messages.slice(index + 1).map((rest) => this.changeVisibility(rest, 0)));
        break;
      }
    }
    return outcomes;
  }

  private async ack(message: Message): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }

  private async delay(message: Message): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    const seconds = Math.min(
      this.options.retryBaseSeconds * 2 ** (receiveCount - 1),
      this.options.maxRetrySeconds,
    );
    await this.changeVisibility(message, seconds);
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: Math.floor(seconds),
      }),
    );
  }

  private async deadLetter(message: Message, code: string, reason: string): Promise<void> {
    this.logger.warn(`dead-lettering message ${message.MessageId}: ${code}`);
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.options.deadLetterQueueUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          failureCode: { DataType: 'String', StringValue: code },
          failureReason: { DataType: 'String', StringValue: reason.slice(0, 1_000) || code },
        },
      }),
    );
    await this.ack(message);
  }
}
