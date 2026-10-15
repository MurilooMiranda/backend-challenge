import { randomUUIDv7 } from 'bun';
import type { Clock, IdGenerator } from '@/application/ports';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class UuidV7Generator implements IdGenerator {
  next(): string {
    return randomUUIDv7();
  }
}
