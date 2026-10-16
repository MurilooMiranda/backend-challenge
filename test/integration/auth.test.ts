import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Role, UnauthenticatedError } from '@/application/auth';
import { InfrastructureUnavailableError } from '@/application/errors';
import { AppModule } from '@/app.module';
import { JwtTokenVerifier } from '@/infrastructure/auth/jwt-token-verifier';
import { TEST_DATABASE_URL, createTestOrm, resetDatabase } from '../support/database';
import { type TestIssuer, startTestIssuer } from '../support/identity';

let issuer: TestIssuer;
let orm: MikroORM;
let app: INestApplication;
let baseUrl: string;
const previousEnv = { ...process.env };

beforeAll(async () => {
  issuer = await startTestIssuer();
  orm = await createTestOrm();
  Object.assign(process.env, {
    DATABASE_URL: TEST_DATABASE_URL,
    WORKERS_ENABLED: 'false',
    AUTH_ENABLED: 'true',
    AUTH_ISSUER: issuer.issuer,
    AUTH_AUDIENCE: issuer.audience,
    AUTH_JWKS_URL: issuer.jwksUrl,
  });
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
  await issuer.stop();
  for (const key of ['AUTH_ENABLED', 'AUTH_ISSUER', 'AUTH_AUDIENCE', 'AUTH_JWKS_URL']) {
    delete process.env[key];
  }
  Object.assign(process.env, previousEnv);
});

const providerToken = (providerId: string) => issuer.token({ roles: [Role.Provider], providerId });
const operatorToken = () => issuer.token({ roles: [Role.Operator] });

async function call(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: (text ? JSON.parse(text) : null) as any,
  };
}

async function createWallet() {
  const { status, body } = await call('POST', '/wallets', await operatorToken(), {
    playerId: crypto.randomUUID(),
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  expect(status).toBe(201);
  return body as { id: string; playerId: string };
}

function bet(wallet: { id: string; playerId: string }, providerId: string) {
  const externalTransactionId = `tx-${crypto.randomUUID()}`;
  return {
    payload: {
      providerId,
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    },
    headers: { 'Idempotency-Key': `${providerId}:${externalTransactionId}` },
  };
}

describe('JwtTokenVerifier', () => {
  const verifier = () =>
    new JwtTokenVerifier({
      issuer: issuer.issuer,
      audience: issuer.audience,
      jwksUrl: issuer.jwksUrl,
      providerClaim: 'provider_id',
    });

  it('maps a provider token to a principal restricted to its provider', async () => {
    const principal = await verifier().verify(await providerToken('provider-a'));
    expect(principal).toEqual({
      subject: 'service-account-provider-a',
      roles: [Role.Provider],
      providerId: 'provider-a',
      unrestricted: false,
    });
  });

  it('an operator token is unrestricted', async () => {
    expect((await verifier().verify(await operatorToken())).unrestricted).toBe(true);
  });

  it.each([
    ['expired', { expiresIn: '-1m' }],
    ['wrong audience', { audience: 'another-api' }],
    ['wrong issuer', { issuer: 'http://evil/realms/wagering' }],
  ])('rejects a %s token', async (_label, options) => {
    const token = await issuer.token({ roles: [Role.Operator], ...options });
    await expect(verifier().verify(token)).rejects.toThrow(UnauthenticatedError);
  });

  it('rejects a token signed by an unknown key', async () => {
    const token = await issuer.token({
      roles: [Role.Operator],
      signWith: await issuer.foreignKey(),
    });
    await expect(verifier().verify(token)).rejects.toThrow(UnauthenticatedError);
  });

  it('rejects a provider token without the provider claim', async () => {
    const token = await issuer.token({ roles: [Role.Provider] });
    await expect(verifier().verify(token)).rejects.toThrow(UnauthenticatedError);
  });

  it('ignores unknown roles', async () => {
    const token = await issuer.token({ roles: ['offline_access', Role.Operator] });
    expect((await verifier().verify(token)).roles).toEqual([Role.Operator]);
  });

  it('an unreachable identity provider is a transient failure, not a 401', async () => {
    const offline = new JwtTokenVerifier({
      issuer: issuer.issuer,
      audience: issuer.audience,
      jwksUrl: 'http://localhost:1/certs',
      providerClaim: 'provider_id',
    });
    await expect(offline.verify(await operatorToken())).rejects.toThrow(
      InfrastructureUnavailableError,
    );
  });
});

describe('HTTP API with authentication enabled', () => {
  it('health, readiness and metrics stay open', async () => {
    expect((await call('GET', '/health/live')).status).toBe(200);
    const ready = await call('GET', '/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks.identityProvider).toBe('up');
    expect((await fetch(`${baseUrl}/metrics`)).status).toBe(200);
  });

  it('401 with WWW-Authenticate when the token is missing or invalid', async () => {
    const missing = await call('GET', `/wallets/${crypto.randomUUID()}`);
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe('UNAUTHENTICATED');
    expect(missing.headers.get('www-authenticate')).toContain('Bearer');

    expect((await call('GET', `/wallets/${crypto.randomUUID()}`, 'not-a-jwt')).status).toBe(401);
    const expired = await issuer.token({ roles: [Role.Operator], expiresIn: '-1m' });
    expect((await call('GET', `/wallets/${crypto.randomUUID()}`, expired)).status).toBe(401);
  });

  it('a provider submits transactions only as itself', async () => {
    const wallet = await createWallet();
    const own = bet(wallet, 'provider-a');
    const accepted = await call(
      'POST',
      '/wagering/transactions',
      await providerToken('provider-a'),
      own.payload,
      own.headers,
    );
    expect(accepted.status).toBe(201);

    const impersonation = bet(wallet, 'provider-b');
    const denied = await call(
      'POST',
      '/wagering/transactions',
      await providerToken('provider-a'),
      impersonation.payload,
      impersonation.headers,
    );
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');
  });

  it('operators cannot submit transactions; providers cannot run back-office operations', async () => {
    const wallet = await createWallet();
    const attempt = bet(wallet, 'provider-a');
    expect(
      (
        await call(
          'POST',
          '/wagering/transactions',
          await operatorToken(),
          attempt.payload,
          attempt.headers,
        )
      ).status,
    ).toBe(403);

    const provider = await providerToken('provider-a');
    expect(
      (
        await call('POST', '/wallets', provider, {
          playerId: crypto.randomUUID(),
          initialBalance: { amount: '1.00', currency: 'BRL' },
        })
      ).status,
    ).toBe(403);
    expect((await call('GET', `/wallets/${wallet.id}/ledger`, provider)).status).toBe(403);
    expect((await call('POST', `/wallets/${wallet.id}/reconciliation`, provider)).status).toBe(403);
    expect((await call('GET', '/ledger/trial-balance', provider)).status).toBe(403);

    const operator = await operatorToken();
    expect((await call('GET', `/wallets/${wallet.id}/ledger`, operator)).status).toBe(200);
    expect((await call('GET', '/ledger/trial-balance', operator)).status).toBe(200);
  });

  it('a provider cannot read another provider transactions', async () => {
    const wallet = await createWallet();
    const own = bet(wallet, 'provider-a');
    const created = await call(
      'POST',
      '/wagering/transactions',
      await providerToken('provider-a'),
      own.payload,
      own.headers,
    );
    const id = created.body.transactionId;

    expect(
      (await call('GET', `/wagering/transactions/${id}`, await providerToken('provider-a'))).status,
    ).toBe(200);
    expect(
      (await call('GET', `/wagering/transactions/${id}`, await providerToken('provider-b'))).status,
    ).toBe(404);
    expect((await call('GET', `/wagering/transactions/${id}`, await operatorToken())).status).toBe(
      200,
    );

    const path = `/providers/provider-a/wagering/transactions/${own.payload.externalTransactionId}`;
    expect((await call('GET', path, await providerToken('provider-a'))).status).toBe(200);
    expect((await call('GET', path, await providerToken('provider-b'))).status).toBe(403);
  });
});
