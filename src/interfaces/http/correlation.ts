import { randomUUIDv7 } from 'bun';

export const CORRELATION_HEADER = 'x-correlation-id';

export function resolveCorrelationId(header: string | undefined): string {
  return header && header.trim() !== '' ? header.trim() : randomUUIDv7();
}
