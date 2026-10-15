import type { LoggerService } from '@nestjs/common';
import { currentLogContext } from './log-context';

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const SEVERITY: Record<Level, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export class JsonLogger implements LoggerService {
  private readonly minimum: number;

  constructor(level: string = process.env.LOG_LEVEL ?? 'info') {
    this.minimum = SEVERITY[(level as Level) in SEVERITY ? (level as Level) : 'info'];
  }

  log(message: unknown, ...params: unknown[]): void {
    this.write('info', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.write('fatal', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.write('trace', message, params);
  }

  private write(level: Level, message: unknown, params: unknown[]): void {
    if (SEVERITY[level] < this.minimum) {
      return;
    }
    const context =
      params.length > 0 && typeof params.at(-1) === 'string' ? params.at(-1) : undefined;
    const stack =
      level === 'error' && params.length > 1 && typeof params[0] === 'string'
        ? params[0]
        : undefined;
    const body =
      message !== null && typeof message === 'object' && !(message instanceof Error)
        ? (message as Record<string, unknown>)
        : { msg: message instanceof Error ? message.message : String(message) };

    const line = {
      level,
      time: new Date().toISOString(),
      ...(context ? { context } : {}),
      ...currentLogContext(),
      ...body,
      ...(stack ? { stack } : {}),
    };
    process.stdout.write(`${JSON.stringify(line)}\n`);
  }
}
