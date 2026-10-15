import { describe, expect, it } from 'bun:test';
import { canonicalJson, computeWagerPayloadHash } from '@/application/wagering/payload-hash';

const fields = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined, b: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"b":[3,{"y":2,"z":1}],"d":2},"b":1}',
    );
  });
});

describe('computeWagerPayloadHash', () => {
  it('is a sha256 hex digest', () => {
    expect(computeWagerPayloadHash(fields)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on key order', () => {
    const reordered = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'fortune-chimp',
      roundId: 'round-987',
      walletId: 'wallet-1',
      playerId: 'player-1',
      externalTransactionId: 'transaction-123',
      providerId: 'provider-a',
    };
    expect(computeWagerPayloadHash(reordered)).toBe(computeWagerPayloadHash(fields));
  });

  it('ignores transport metadata', () => {
    const withMetadata = { ...fields, idempotencyKey: 'x', correlationId: 'y', causationId: 'z' };
    expect(computeWagerPayloadHash(withMetadata)).toBe(computeWagerPayloadHash(fields));
  });

  it.each([
    ['amount', { money: { amount: '25.01', currency: 'BRL' } }],
    ['currency', { money: { amount: '25.00', currency: 'USD' } }],
    ['kind', { kind: 'WIN' }],
    ['round', { roundId: 'round-988' }],
    ['reference', { referenceExternalTransactionId: 'tx-0' }],
  ])('changes when the %s changes', (_label, change) => {
    expect(computeWagerPayloadHash({ ...fields, ...change })).not.toBe(
      computeWagerPayloadHash(fields),
    );
  });
});
