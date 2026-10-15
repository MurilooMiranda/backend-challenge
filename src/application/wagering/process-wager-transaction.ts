import { type MoneyProps, Money } from '@/domain/money/money';
import { ReferenceRetryPolicy } from '@/domain/wagering/reference-retry-policy';
import { WagerSettlement } from '@/domain/wagering/wager-settlement';
import { WagerTransaction, type WagerTransactionKind } from '@/domain/wagering/wager-transaction';
import {
  IdempotencyConflictError,
  InvalidCommandError,
  UniqueViolationError,
  WalletNotFoundError,
} from '../errors';
import type { Clock, IdGenerator, TransactionRunner, WageringUnitOfWork } from '../ports';
import { computeWagerPayloadHash } from './payload-hash';
import { settlementEvents } from './wager-events';
import { type WagerTransactionResult, toWagerTransactionResult } from './wager-transaction-result';

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
}

const MAX_ATTEMPTS = 3;

export class ProcessWagerTransaction {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly retryPolicy: ReferenceRetryPolicy = ReferenceRetryPolicy.default(),
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<WagerTransactionResult> {
    if (typeof command.idempotencyKey !== 'string' || command.idempotencyKey.trim() === '') {
      throw new InvalidCommandError('idempotency key is required');
    }
    const money = Money.from(command.money);
    const payloadHash = computeWagerPayloadHash({ ...command, money: money.toJSON() });

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.transactions.run((uow) => this.process(uow, command, money, payloadHash));
      } catch (error) {
        if (error instanceof UniqueViolationError && attempt < MAX_ATTEMPTS) {
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
    const earlyReplay = await this.findReplay(uow, command, payloadHash);
    if (earlyReplay) {
      return earlyReplay;
    }

    const wallet = await uow.lockWallet(command.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(command.walletId);
    }

    const replay = await this.findReplay(uow, command, payloadHash);
    if (replay) {
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

    const reference =
      tx.requiresReference() && tx.referenceExternalTransactionId
        ? ((await uow.findTransactionByExternalId(
            tx.providerId,
            tx.referenceExternalTransactionId,
          )) ?? undefined)
        : undefined;
    const referenceAlreadyReversed = reference
      ? await uow.hasProcessedReversal(reference.id)
      : false;

    const { entry } = WagerSettlement.settle(tx, {
      wallet,
      ...(reference ? { reference } : {}),
      referenceAlreadyReversed,
      entryId: this.ids.next(),
      at: now,
      retryPolicy: this.retryPolicy,
    });

    uow.addTransaction(tx);
    if (entry) {
      uow.addLedgerEntry(entry);
      uow.saveWallet(wallet);
    }
    uow.addOutboxMessages(
      settlementEvents(tx, wallet, entry, () => ({
        eventId: this.ids.next(),
        correlationId: command.correlationId,
        ...(command.causationId !== undefined ? { causationId: command.causationId } : {}),
        occurredAt: now,
      })),
    );

    return toWagerTransactionResult(tx, false);
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
