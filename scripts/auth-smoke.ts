const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? 'http://localhost:8080';
const APP_URL = process.env.APP_URL ?? 'http://localhost:3001';
const REALM = process.env.KEYCLOAK_REALM ?? 'wagering';

const clients = {
  'provider-a': 'provider-a-secret',
  'provider-b': 'provider-b-secret',
  backoffice: 'backoffice-secret',
} as const;

type ClientId = keyof typeof clients;

interface Check {
  name: string;
  expected: number | string;
  actual: number | string;
}

const checks: Check[] = [];

function record(name: string, expected: number | string, actual: number | string) {
  checks.push({ name, expected, actual });
}

async function token(clientId: ClientId): Promise<string> {
  const response = await fetch(`${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clients[clientId],
    }),
  });
  if (!response.ok) {
    throw new Error(
      `token request for ${clientId} failed: ${response.status} ${await response.text()}`,
    );
  }
  return ((await response.json()) as { access_token: string }).access_token;
}

function claims(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8'));
}

async function call(method: string, path: string, bearer?: string, body?: unknown, headers = {}) {
  const response = await fetch(`${APP_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as any };
}

function bet(wallet: { id: string; playerId: string }, providerId: string) {
  const externalTransactionId = `smoke-${crypto.randomUUID()}`;
  return {
    body: {
      providerId,
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-smoke',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    },
    headers: { 'Idempotency-Key': `${providerId}:${externalTransactionId}` },
  };
}

const providerA = await token('provider-a');
const providerB = await token('provider-b');
const backoffice = await token('backoffice');

const sample = claims(providerA);
console.log('provider-a token claims:', {
  iss: sample.iss,
  aud: sample.aud,
  azp: sample.azp,
  provider_id: sample.provider_id,
  roles: (sample.realm_access as { roles?: string[] } | undefined)?.roles,
});

const ready = await call('GET', '/health/ready');
record('GET /health/ready (no token)', 200, ready.status);
record('identityProvider check', 'up', ready.body?.checks?.identityProvider ?? 'missing');

record(
  'GET /wallets/:id without token',
  401,
  (await call('GET', `/wallets/${crypto.randomUUID()}`)).status,
);

const created = await call('POST', '/wallets', backoffice, {
  playerId: crypto.randomUUID(),
  initialBalance: { amount: '100.00', currency: 'BRL' },
});
record('backoffice POST /wallets', 201, created.status);
const wallet = created.body as { id: string; playerId: string };

record(
  'provider-a POST /wallets',
  403,
  (
    await call('POST', '/wallets', providerA, {
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '1.00', currency: 'BRL' },
    })
  ).status,
);

const own = bet(wallet, 'provider-a');
const accepted = await call('POST', '/wagering/transactions', providerA, own.body, own.headers);
record('provider-a BET as provider-a', 201, accepted.status);

const impersonation = bet(wallet, 'provider-b');
record(
  'provider-a BET as provider-b',
  403,
  (
    await call(
      'POST',
      '/wagering/transactions',
      providerA,
      impersonation.body,
      impersonation.headers,
    )
  ).status,
);

const transactionPath = `/wagering/transactions/${accepted.body?.transactionId}`;
record(
  'provider-a reads its transaction',
  200,
  (await call('GET', transactionPath, providerA)).status,
);
record(
  'provider-b reads provider-a transaction',
  404,
  (await call('GET', transactionPath, providerB)).status,
);
record(
  'provider-a GET /ledger/trial-balance',
  403,
  (await call('GET', '/ledger/trial-balance', providerA)).status,
);

const books = await call('GET', '/ledger/trial-balance', backoffice);
record('backoffice GET /ledger/trial-balance', 200, books.status);
record('trial balance balanced', 'true', String(books.body?.balanced));

console.table(
  checks.map((check) => ({
    check: check.name,
    expected: check.expected,
    actual: check.actual,
    result: check.expected === check.actual ? 'ok' : 'FAIL',
  })),
);

const failed = checks.filter((check) => check.expected !== check.actual);
if (failed.length > 0) {
  console.error(`${failed.length} check(s) failed`);
  process.exit(1);
}
console.log('all authentication checks passed');

export {};
