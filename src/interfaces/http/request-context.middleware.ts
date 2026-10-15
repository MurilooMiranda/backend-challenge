import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { currentLogContext, runWithLogContext } from '@/infrastructure/observability/log-context';
import { CORRELATION_HEADER, resolveCorrelationId } from './correlation';

const logger = new Logger('Http');
const QUIET_PATHS = ['/metrics', '/health'];

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const correlationId = resolveCorrelationId(req.header(CORRELATION_HEADER));
  req.headers[CORRELATION_HEADER] = correlationId;
  res.setHeader(CORRELATION_HEADER, correlationId);
  const startedAt = performance.now();
  const path = req.originalUrl.split('?')[0] ?? req.originalUrl;

  runWithLogContext({ correlationId }, () => {
    const context = currentLogContext();
    res.on('finish', () => {
      if (QUIET_PATHS.some((quiet) => path.startsWith(quiet))) {
        return;
      }
      runWithLogContext(context, () =>
        logger.log({
          msg: 'http request',
          method: req.method,
          path,
          status: res.statusCode,
          durationMs: Math.round(performance.now() - startedAt),
        }),
      );
    });
    next();
  });
}
