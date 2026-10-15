import { describe, expect, it, spyOn } from 'bun:test';
import { JsonLogger } from '@/infrastructure/observability/json-logger';
import { addLogContext, runWithLogContext } from '@/infrastructure/observability/log-context';

function capture(run: () => void): Record<string, unknown>[] {
  const lines: string[] = [];
  const spy = spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return lines.map((line) => JSON.parse(line));
}

describe('JsonLogger', () => {
  it('writes one JSON object per line with level, time, context and message', () => {
    const [line] = capture(() => new JsonLogger('info').log('hello', 'Test'));
    expect(line).toMatchObject({ level: 'info', context: 'Test', msg: 'hello' });
    expect(typeof line!.time).toBe('string');
  });

  it('merges the async log context with structured fields', async () => {
    const lines = await runWithLogContext({ correlationId: 'corr-1' }, async () => {
      await Promise.resolve();
      addLogContext({ walletId: 'wallet-1', transactionId: 'tx-1' });
      return capture(() => new JsonLogger().log({ msg: 'settled', status: 'PROCESSED' }));
    });
    expect(lines[0]).toMatchObject({
      correlationId: 'corr-1',
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      msg: 'settled',
      status: 'PROCESSED',
    });
  });

  it('respects the minimum level and keeps error stacks', () => {
    expect(capture(() => new JsonLogger('warn').log('ignored'))).toHaveLength(0);
    expect(capture(() => new JsonLogger('warn').error('kept', 'stack', 'Ctx'))[0]).toMatchObject({
      level: 'error',
      msg: 'kept',
      stack: 'stack',
      context: 'Ctx',
    });
  });
});
