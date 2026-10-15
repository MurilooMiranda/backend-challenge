import { AsyncLocalStorage } from 'node:async_hooks';

export type LogFields = Record<string, string | number | boolean | null | undefined>;

const storage = new AsyncLocalStorage<LogFields>();

export function runWithLogContext<T>(fields: LogFields, work: () => T): T {
  return storage.run({ ...storage.getStore(), ...fields }, work);
}

export function addLogContext(fields: LogFields): void {
  const current = storage.getStore();
  if (current) {
    Object.assign(current, fields);
  }
}

export function currentLogContext(): LogFields {
  return storage.getStore() ?? {};
}
