import { Logger } from '@nestjs/common';
import { context, trace } from '@opentelemetry/api';
import type { NextFunction, Request, Response } from 'express';
import { currentLogContext, runWithLogContext } from '@/infrastructure/observability/log-context';
import {
  SpanKind,
  SpanStatusCode,
  extractTraceContext,
  tracer,
} from '@/infrastructure/observability/tracing';
import { CORRELATION_HEADER, resolveCorrelationId } from './correlation';

const logger = new Logger('Http');
const QUIET_PATHS = ['/metrics', '/health'];

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const correlationId = resolveCorrelationId(req.header(CORRELATION_HEADER));
  req.headers[CORRELATION_HEADER] = correlationId;
  res.setHeader(CORRELATION_HEADER, correlationId);
  const startedAt = performance.now();
  const path = req.originalUrl.split('?')[0] ?? req.originalUrl;
  const quiet = QUIET_PATHS.some((prefix) => path.startsWith(prefix));

  const parent = extractTraceContext(req.headers as Record<string, string>);
  const span = quiet
    ? undefined
    : tracer().startSpan(
        `HTTP ${req.method}`,
        {
          kind: SpanKind.SERVER,
          attributes: {
            'http.request.method': req.method,
            'url.path': path,
            'correlation.id': correlationId,
          },
        },
        parent,
      );
  const traceId = span?.isRecording() ? span.spanContext().traceId : undefined;
  if (traceId) {
    res.setHeader('x-trace-id', traceId);
  }

  context.with(span ? trace.setSpan(parent, span) : parent, () =>
    runWithLogContext({ correlationId }, () => {
      const logFields = currentLogContext();
      res.on('finish', () => {
        if (span) {
          const route = (req as Request & { route?: { path?: string } }).route?.path;
          if (route) {
            span.updateName(`${req.method} ${req.baseUrl}${route}`);
            span.setAttribute('http.route', `${req.baseUrl}${route}`);
          }
          span.setAttribute('http.response.status_code', res.statusCode);
          if (res.statusCode >= 500) {
            span.setStatus({ code: SpanStatusCode.ERROR });
          }
          span.end();
        }
        if (quiet) {
          return;
        }
        runWithLogContext(logFields, () =>
          logger.log({
            msg: 'http request',
            method: req.method,
            path,
            status: res.statusCode,
            durationMs: Math.round(performance.now() - startedAt),
            ...(traceId ? { traceId } : {}),
          }),
        );
      });
      next();
    }),
  );
}
