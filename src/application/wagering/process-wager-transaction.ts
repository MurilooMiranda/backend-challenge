import { LedgerAccount } from '@/domain/ledger/ledger-account';
import { InboxMessage } from '@/domain/messaging/inbox-message';
import { type MoneyProps, Money } from '@/domain/money/money';
import { ReferenceRetryPolicy } from '@/domain/wagering/reference-retry-policy';
import { WagerTransaction, type WagerTransactionKind } from '@/domain/wagering/wager-transaction';
import {
  IdempotencyConflictError,
  InboxPayloadMismatchError,
  InvalidCommandError,
  UniqueViolationError,
  WalletNotFoundError,
} from '../errors';
import type { Clock, IdGenerator, TransactionRunner, WageringUnitOfWork } from '../ports';
import { type Channel, type Telemetry, noopTelemetry } from '../telemetry';
import { computeWagerPayloadHash } from './payload-hash';
import { settleAndStage } from './settle-and-stage';
import { type WagerTransactionResult, toWagerTransactionResult } from './wager-transaction-result';

export interface InboxReference {
  consumerName: string;
  messageId: string;
}

export interface ProcessWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
  correlationId: string;
  causationId?: string | undefined;
  inbox?: InboxReference | undefined;
  channel?: Channel | undefined;
}

const MAX_ATTEMPTS = 3;

export class ProcessWagerTransaction {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly retryPolicy: ReferenceRetryPolicy = ReferenceRetryPolicy.default(),
    private readonly telemetry: Telemetry = noopTelemetry,
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<WagerTransactionResult> {
    if (typeof command.idempotencyKey !== 'string' || command.idempotencyKey.trim() === '') {
      throw new InvalidCommandError('idempotency key is required');
    }
    const startedAt = performance.now();
    const money = Money.from(command.money);
    const payloadHash = computeWagerPayloadHash({ ...command, money: money.toJSON() });

    for (let attempt = 1; ; attempt++) {
      try {
        const result = await this.transactions.run((uow) =>
          this.process(uow, command, money, payloadHash),
        );
        this.telemetry.transactionSettled({
          channel: command.channel ?? 'http',
          transactionId: result.transactionId,
          walletId: command.walletId,
          providerId: command.providerId,
          kind: command.kind,
          status: result.status,
          failureCode: result.failureCode,
          idempotentReplay: result.idempotentReplay,
          durationSeconds: (performance.now() - startedAt) / 1000,
        });
        return result;
      } catch (error) {
        // Duas transações com a mesma chave de idempotência apontando para wallets diferentes não
        // se bloqueiam no lock da wallet; quem as separa é o UNIQUE do banco. Refazer do zero faz
        // a busca de idempotência encontrar a vencedora e responder replay ou conflito.
        if (error instanceof UniqueViolationError && attempt < MAX_ATTEMPTS) {
          this.telemetry.lockConflict(error.constraint ?? 'unique_violation');
          continue;
        }
        throw error;
      }
    }
  }

  private async process(
    uow: WageringUnitOfWork,
    command: ProcessWagerTransactionCommand,
    money: Money,
    payloadHash: string,
  ): Promise<WagerTransactionResult> {
    const alreadyConsumed = await this.isAlreadyConsumed(uow, command, payloadHash);

    // Primeira busca, antes do lock: um replay responde sem entrar na fila da wallet. Uma mensagem
    // nova da fila que repete uma transação já feita (por exemplo, por HTTP) ainda entra na inbox.
    const earlyReplay = await this.findReplay(uow, command, payloadHash);
    if (earlyReplay) {
      if (!alreadyConsumed) {
        this.recordInbox(uow, command, payloadHash);
      }
      return earlyReplay;
    }

    // A conta da casa é compartilhada por todas as apostas do provedor; garanti-la antes de travar
    // a wallet mantém a seção crítica curta.
    await uow.ensureAccounts([LedgerAccount.house(command.providerId, money.currency)]);

    const wallet = await uow.lockWallet(command.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(command.walletId);
    }

    // Segunda busca, já com o lock: pega quem esperou na fila atrás da transação original.
    const replay = await this.findReplay(uow, command, payloadHash);
    if (replay) {
      if (!alreadyConsumed) {
        this.recordInbox(uow, command, payloadHash);
      }
      return replay;
    }

    const now = this.clock.now();
    const tx = WagerTransaction.create({
      id: this.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind as WagerTransactionKind,
      money,
      ...(command.referenceExternalTransactionId !== undefined
        ? { referenceExternalTransactionId: command.referenceExternalTransactionId }
        : {}),
      createdAt: now,
    });

    await settleAndStage(uow, tx, wallet, {
      ids: this.ids,
      retryPolicy: this.retryPolicy,
      at: now,
      correlationId: command.correlationId,
      causationId: command.causationId,
      isNew: true,
    });
    this.recordInbox(uow, command, payloadHash);

    return toWagerTransactionResult(tx, false);
  }

  private async isAlreadyConsumed(
    uow: WageringUnitOfWork,
    command: ProcessWagerTransactionCommand,
    payloadHash: string,
  ): Promise<boolean> {
    if (!command.inbox) {
      return false;
    }
    const seen = await uow.findInboxMessage(command.inbox.consumerName, command.inbox.messageId);
    if (!seen) {
      return false;
    }
    if (!seen.matchesPayload(payloadHash)) {
      throw new InboxPayloadMismatchError(command.inbox.consumerName, command.inbox.messageId);
    }
    return true;
  }

  private recordInbox(
    uow: WageringUnitOfWork,
    command: ProcessWagerTransactionCommand,
    payloadHash: string,
  ): void {
    if (!command.inbox) {
      return;
    }
    const now = this.clock.now();
    const message = InboxMessage.receive({
      consumerName: command.inbox.consumerName,
      messageId: command.inbox.messageId,
      payloadHash,
      receivedAt: now,
    });
    message.markProcessed(now);
    uow.addInboxMessage(message);
  }

  private async findReplay(
    uow: WageringUnitOfWork,
    command: ProcessWagerTransactionCommand,
    payloadHash: string,
  ): Promise<WagerTransactionResult | null> {
    const existing = await uow.findExistingTransactions(
      command.idempotencyKey,
      command.providerId,
      command.externalTransactionId,
    );
    if (existing.length === 0) {
      return null;
    }

    const sameKey = existing.find((tx) => tx.idempotencyKey === command.idempotencyKey);
    if (!sameKey || !sameKey.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(command.idempotencyKey);
    }
    return toWagerTransactionResult(sameKey, true);
  }
}
