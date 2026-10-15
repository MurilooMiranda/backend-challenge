import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { AppModule } from '@/app.module';
import { TEST_DATABASE_URL, createTestOrm, resetDatabase } from '../support/database';

let orm: MikroORM;
let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  orm = await createTestOrm();
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.WORKERS_ENABLED = 'false';
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');
});

beforeEach(async () => {
  await resetDatabase(orm);
});

afterAll(async () => {
  await app.close();
  await orm.close();
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

async function get(path: string) {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: (await response.json()) as any };
}

async function createWallet(amount = '1000.00') {
  const playerId = crypto.randomUUID();
  const { status, body } = await post('/wallets', {
    playerId,
    initialBalance: { amount, currency: 'BRL' },
  });
  expect(status).toBe(201);
  return body as { id: string; playerId: string };
}

function wager(wallet: { id: string; playerId: string }, overrides: Record<string, unknown> = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: `transaction-${crypto.randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

const keyFor = (payload: { providerId: string; externalTransactionId: string }) => ({
  'Idempotency-Key': `${payload.providerId}:${payload.externalTransactionId}`,
});

describe('health', () => {
  it('GET /health/live is open', async () => {
    const { status } = await get('/health/live');
    expect(status).toBe(200);
  });
});

describe('POST /wallets', () => {
  it('201 with the contract shape', async () => {
    const playerId = crypto.randomUUID();
    const { status, body } = await post('/wallets', {
      playerId,
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });
    expect(status).toBe(201);
    expect(body).toEqual({
      id: expect.any(String),
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
  });

  it('409 for a duplicate player + currency', async () => {
    const wallet = await createWallet();
    const { status, body } = await post('/wallets', {
      playerId: wallet.playerId,
      initialBalance: { amount: '1.00', currency: 'BRL' },
    });
    expect(status).toBe(409);
    expect(body.error.code).toBe('WALLET_ALREADY_EXISTS');
  });

  it('400 for an invalid amount', async () => {
    const { status, body } = await post('/wallets', {
      playerId: 'p',
      initialBalance: { amount: '10.5', currency: 'BRL' },
    });
    expect(status).toBe(400);
    expect(body.error.code).toBe('INVALID_MONEY');
  });

  it('GET /wallets/:id returns the wallet, 404 when unknown', async () => {
    const wallet = await createWallet('50.00');
    const found = await get(`/wallets/${wallet.id}`);
    expect(found.status).toBe(200);
    expect(found.body.balance).toEqual({ amount: '50.00', currency: 'BRL' });

    const missing = await get(`/wallets/${crypto.randomUUID()}`);
    expect(missing.status).toBe(404);
  });
});

describe('POST /wagering/transactions', () => {
  it('201 processed, then 200 idempotent replay with the same result', async () => {
    const wallet = await createWallet('1000.00');
    const payload = wager(wallet);

    const first = await post('/wagering/transactions', payload, keyFor(payload));
    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      failureCode: null,
      idempotentReplay: false,
    });

    const replay = await post('/wagering/transactions', payload, keyFor(payload));
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  it('409 when the idempotency key is reused with a different payload', async () => {
    const wallet = await createWallet();
    const payload = wager(wallet);
    await post('/wagering/transactions', payload, keyFor(payload));

    const conflict = await post(
      '/wagering/transactions',
      { ...payload, money: { amount: '99.00', currency: 'BRL' } },
      keyFor(payload),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('422 for a business rejection, with a failureCode', async () => {
    const wallet = await createWallet('10.00');
    const payload = wager(wallet, { money: { amount: '80.00', currency: 'BRL' } });
    const { status, body } = await post('/wagering/transactions', payload, keyFor(payload));
    expect(status).toBe(422);
    expect(body.status).toBe('REJECTED');
    expect(body.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  it('202 when the reference has not arrived yet', async () => {
    const wallet = await createWallet();
    const payload = wager(wallet, { kind: 'ROLLBACK', referenceExternalTransactionId: 'later' });
    const { status, body } = await post('/wagering/transactions', payload, keyFor(payload));
    expect(status).toBe(202);
    expect(body.status).toBe('PENDING_REFERENCE');
  });

  it('400 without Idempotency-Key header', async () => {
    const wallet = await createWallet();
    const { status, body } = await post('/wagering/transactions', wager(wallet));
    expect(status).toBe(400);
    expect(body.error.code).toBe('INVALID_PAYLOAD');
  });

  it('400 for OPENING, unknown kinds and malformed money', async () => {
    const wallet = await createWallet();
    for (const overrides of [
      { kind: 'OPENING' },
      { kind: 'JACKPOT' },
      { money: { amount: 25, currency: 'BRL' } },
      { money: { amount: '1e3', currency: 'BRL' } },
      { walletId: 'not-a-uuid' },
    ]) {
      const payload = wager(wallet, overrides);
      const { status } = await post('/wagering/transactions', payload, keyFor(payload));
      expect(status).toBe(400);
    }
  });

  it('404 for an unknown wallet', async () => {
    const payload = wager({ id: crypto.randomUUID(), playerId: 'p' });
    const { status, body } = await post('/wagering/transactions', payload, keyFor(payload));
    expect(status).toBe(404);
    expect(body.error.code).toBe('WALLET_NOT_FOUND');
  });

  it('transactions can be queried by internal id and by provider id', async () => {
    const wallet = await createWallet();
    const payload = wager(wallet);
    const { body } = await post('/wagering/transactions', payload, keyFor(payload));

    const byId = await get(`/wagering/transactions/${body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body.externalTransactionId).toBe(payload.externalTransactionId);

    const byProvider = await get(
      `/providers/provider-a/wagering/transactions/${payload.externalTransactionId}`,
    );
    expect(byProvider.status).toBe(200);
    expect(byProvider.body.transactionId).toBe(body.transactionId);

    expect((await get(`/wagering/transactions/${crypto.randomUUID()}`)).status).toBe(404);
  });
});

describe('GET /wallets/:id/ledger', () => {
  it('paginates with a stable opaque cursor in insertion order', async () => {
    const wallet = await createWallet('100.00');
    for (let i = 0; i < 5; i++) {
      const payload = wager(wallet, { money: { amount: '1.00', currency: 'BRL' } });
      await post('/wagering/transactions', payload, keyFor(payload));
    }

    const first = await get(`/wallets/${wallet.id}/ledger?limit=4`);
    expect(first.status).toBe(200);
    expect(first.body.entries).toHaveLength(4);
    expect(first.body.entries[0].direction).toBe('CREDIT');
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await get(
      `/wallets/${wallet.id}/ledger?limit=4&cursor=${first.body.nextCursor}`,
    );
    expect(second.body.entries).toHaveLength(2);
    expect(second.body.nextCursor).toBeNull();
    expect(second.body.entries.at(-1).balanceAfter).toEqual({ amount: '95.00', currency: 'BRL' });

    const ids = [...first.body.entries, ...second.body.entries].map((e: { id: string }) => e.id);
    expect(new Set(ids).size).toBe(6);
  });

  it('400 for an invalid cursor or limit, 404 for an unknown wallet', async () => {
    const wallet = await createWallet('1.00');
    expect((await get(`/wallets/${wallet.id}/ledger?cursor=garbage`)).status).toBe(400);
    expect((await get(`/wallets/${wallet.id}/ledger?limit=0`)).status).toBe(400);
    expect((await get(`/wallets/${wallet.id}/ledger?limit=abc`)).status).toBe(400);
    expect((await get(`/wallets/${crypto.randomUUID()}/ledger`)).status).toBe(404);
  });
});

describe('POST /wallets/:id/reconciliation', () => {
  it('reports a consistent wallet', async () => {
    const wallet = await createWallet('1000.00');
    const payload = wager(wallet);
    await post('/wagering/transactions', payload, keyFor(payload));

    const { status, body } = await post(`/wallets/${wallet.id}/reconciliation`, {});
    expect(status).toBe(200);
    expect(body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '975.00', currency: 'BRL' },
      calculatedBalance: { amount: '975.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      journalBalance: { amount: '975.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
  });

  it('flags a divergence without correcting it and counts it in the metrics', async () => {
    const wallet = await createWallet('100.00');
    await orm.em.fork().transactional(async (em) => {
      await em.execute('SET LOCAL session_replication_role = replica');
      await em.execute('UPDATE wallets SET balance = 90.00 WHERE id = ?', [wallet.id]);
    });

    const { body } = await post(`/wallets/${wallet.id}/reconciliation`, {});
    expect(body.consistent).toBe(false);
    expect(body.storedBalance.amount).toBe('90.00');
    expect(body.calculatedBalance.amount).toBe('100.00');
    expect(body.difference.amount).toBe('-10.00');
    expect(body.journalBalance.amount).toBe('100.00');

    const after = await get(`/wallets/${wallet.id}`);
    expect(after.body.balance.amount).toBe('90.00');

    const metrics = await (await fetch(`${baseUrl}/metrics`)).text();
    expect(metrics).toContain('wallet_reconciliations_total{result="divergent"} 1');
  });
});

describe('GET /ledger/trial-balance', () => {
  it('debits equal credits across player, house and funding accounts', async () => {
    const wallet = await createWallet('100.00');
    const bet = wager(wallet, { money: { amount: '30.00', currency: 'BRL' } });
    await post('/wagering/transactions', bet, keyFor(bet));
    const win = wager(wallet, { kind: 'WIN', money: { amount: '50.00', currency: 'BRL' } });
    await post('/wagering/transactions', win, keyFor(win));
    const refund = wager(wallet, {
      kind: 'REFUND',
      money: { amount: '30.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    await post('/wagering/transactions', refund, keyFor(refund));

    const { status, body } = await get('/ledger/trial-balance?currency=BRL');
    expect(status).toBe(200);
    expect(body.balanced).toBe(true);
    expect(body.unbalancedJournalEntries).toBe(0);
    expect(body.journalEntries).toBe(4);
    expect(body.totalDebits).toEqual(body.totalCredits);
    expect(body.playerWallets.balance).toEqual({ amount: '150.00', currency: 'BRL' });
    expect(body.accounts).toEqual([
      expect.objectContaining({
        code: 'FUNDING:BRL',
        balance: { amount: '-100.00', currency: 'BRL' },
      }),
      expect.objectContaining({
        code: 'HOUSE:provider-a:BRL',
        balance: { amount: '-50.00', currency: 'BRL' },
      }),
    ]);
  });

  it('400 for an invalid currency', async () => {
    expect((await get('/ledger/trial-balance?currency=brl')).status).toBe(400);
  });
});

describe('GET /metrics', () => {
  it('exposes the operational metrics in Prometheus format', async () => {
    const wallet = await createWallet('100.00');
    const payload = wager(wallet);
    await post('/wagering/transactions', payload, keyFor(payload));
    await post('/wagering/transactions', payload, keyFor(payload));

    const response = await fetch(`${baseUrl}/metrics`);
    expect(response.status).toBe(200);
    const text = await response.text();
    for (const name of [
      'wager_transactions_total{channel="http",kind="BET",status="PROCESSED"}',
      'wager_duplicates_total{channel="http"}',
      'wager_processing_duration_seconds_bucket',
      'wallet_lock_wait_seconds_bucket',
      'outbox_pending_messages',
      'outbox_lag_seconds',
      'sqs_dead_letter_queue_messages',
    ]) {
      expect(text).toContain(name);
    }
  });
});
