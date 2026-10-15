import { WalletBalanceChanged } from '@/domain/events/wagering-events';
import { OutboxMessage } from '@/domain/messaging/outbox-message';
import { type MoneyProps, Money } from '@/domain/money/money';
import { WagerTransaction } from '@/domain/wagering/wager-transaction';
import { Wallet } from '@/domain/wallet/wallet';
import { InvalidCommandError, UniqueViolationError, WalletAlreadyExistsError } from '../errors';
import type { Clock, IdGenerator, TransactionRunner } from '../ports';
import { type WalletView, toWalletView } from './wallet-view';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

const WALLET_UNIQUE_CONSTRAINT = 'wallets_player_currency_uq';

export class OpenWallet {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: OpenWalletCommand): Promise<WalletView> {
    if (typeof command.playerId !== 'string' || command.playerId.trim() === '') {
      throw new InvalidCommandError('playerId is required');
    }
    const initialBalance = Money.from(command.initialBalance);

    try {
      return await this.transactions.run(async (uow) => {
        const now = this.clock.now();
        const { wallet, openingEntry } = Wallet.open({
          id: this.ids.next(),
          playerId: command.playerId,
          initialBalance,
          openingTransactionId: this.ids.next(),
          openingEntryId: this.ids.next(),
          at: now,
        });

        uow.addWallet(wallet);
        if (openingEntry) {
          uow.addTransaction(
            WagerTransaction.opening({
              id: openingEntry.transactionId,
              walletId: wallet.id,
              playerId: wallet.playerId,
              money: initialBalance,
              at: now,
            }),
          );
          uow.addLedgerEntry(openingEntry);
          uow.addOutboxMessages([
            OutboxMessage.enqueue(
              WalletBalanceChanged.from(wallet, openingEntry, {
                eventId: this.ids.next(),
                correlationId: command.correlationId,
                occurredAt: now,
              }),
            ),
          ]);
        }

        return toWalletView(wallet);
      });
    } catch (error) {
      if (error instanceof UniqueViolationError && error.constraint === WALLET_UNIQUE_CONSTRAINT) {
        throw new WalletAlreadyExistsError(command.playerId, initialBalance.currency);
      }
      throw error;
    }
  }
}
