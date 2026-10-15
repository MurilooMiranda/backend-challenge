import { describe, expect, it } from 'bun:test';
import { InvalidCommandError } from '@/application/errors';
import { decodeLedgerCursor, encodeLedgerCursor } from '@/application/wallets/get-wallet-ledger';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('ledger cursor', () => {
  it('round-trips and does not expose the raw sequence', () => {
    const cursor = encodeLedgerCursor('12345');
    expect(cursor).not.toContain('12345');
    expect(decodeLedgerCursor(cursor)).toBe('12345');
  });

  it.each([
    ['not base64 json', 'garbage'],
    ['unknown version', encode({ v: 2, s: '1' })],
    ['non numeric sequence', encode({ v: 1, s: '1; drop table' })],
  ])('rejects %s', (_label, cursor) => {
    expect(() => decodeLedgerCursor(cursor)).toThrow(InvalidCommandError);
  });
});
