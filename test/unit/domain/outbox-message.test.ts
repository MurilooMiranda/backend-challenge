import { describe, expect, it } from 'bun:test';
import { WalletBalanceChanged } from '@/domain/events/wagering-events';
import { LedgerDirection } from '@/domain/ledger/wallet-ledger-entry';
import { OutboxMessage } from '@/domain/messaging/outbox-message';
import { Money } from '@/domain/money/money';
import { Wallet } from '@/domain/wallet/wallet';

const at = new Date('2026-01-01T00:00:00.000Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

function balanceChangedEvent() {
  const { wallet } = Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl('100.00'),
    openingTransactionId: 'tx-open',
    openingEntryId: 'entry-open',
    at,
  });
  const entry = wallet.debit({
    transactionId: 'tx-1',
    entryId: 'entry-1',
    money: brl('25.00'),
    at,
  });
  return WalletBalanceChanged.from(wallet, entry, {
    eventId: 'event-1',
    correlationId: 'corr-1',
    causationId: 'msg-1',
    occurredAt: at,
  });
}

describe('IntegrationEvent', () => {
  it('serializes a stable, versioned envelope with money as decimal strings', () => {
    const json = balanceChangedEvent().toJSON();
    expect(json).toEqual({
      eventId: 'event-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: '2026-01-01T00:00:00.000Z',
      version: 1,
      data: {
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  it('data is frozen', () => {
    const event = balanceChangedEvent();
    expect(Object.isFrozen(event.data)).toBe(true);
  });
});

describe('OutboxMessage', () => {
  it('enqueue uses the event id and is immediately due', () => {
    const message = OutboxMessage.enqueue(balanceChangedEvent());
    expect(message.id).toBe('event-1');
    expect(message.eventType).toBe('WalletBalanceChanged');
    expect(message.aggregateId).toBe('wallet-1');
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(at)).toBe(true);
  });

  it('scheduleRetry backs off exponentially up to a cap', () => {
    const message = OutboxMessage.enqueue(balanceChangedEvent());
    const delays: number[] = [];
    for (let i = 0; i < 10; i++) {
      message.scheduleRetry(at, 'boom');
      delays.push(message.nextAttemptAt.getTime() - at.getTime());
    }
    expect(delays.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(Math.max(...delays)).toBe(60_000);
    expect(message.attempts).toBe(10);
    expect(message.lastError).toBe('boom');
    expect(message.isDue(at)).toBe(false);
  });

  it('markPublished is idempotent and makes it no longer pending', () => {
    const message = OutboxMessage.enqueue(balanceChangedEvent());
    message.markPublished(at);
    message.markPublished(new Date(at.getTime() + 1));
    expect(message.isPending()).toBe(false);
    expect(message.publishedAt).toEqual(at);
    expect(message.isDue(new Date(at.getTime() + 999_999))).toBe(false);
  });
});
