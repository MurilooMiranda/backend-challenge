import os from 'node:os';
import {
  type Attributes,
  type Context,
  type Span,
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

export type TraceHeaders = Record<string, string>;

export interface TracingOptions {
  serviceName?: string;
  exporter?: SpanExporter;
  otlpEndpoint?: string;
}

let provider: BasicTracerProvider | undefined;
let contextManager: AsyncLocalStorageContextManager | undefined;

export function tracingOptionsFromEnv(): TracingOptions | undefined {
  if (process.env.OTEL_ENABLED !== 'true') {
    return undefined;
  }
  return {
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'wagering-service',
    otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318',
  };
}

export function setupTracing(options: TracingOptions | undefined = tracingOptionsFromEnv()): void {
  if (provider || !options) {
    return;
  }
  const processor: SpanProcessor = options.exporter
    ? new SimpleSpanProcessor(options.exporter)
    : new BatchSpanProcessor(new OTLPTraceExporter({ url: `${options.otlpEndpoint}/v1/traces` }));

  provider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName ?? 'wagering-service',
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? 'dev',
      'service.instance.id': `${os.hostname()}:${process.pid}`,
    }),
    spanProcessors: [processor],
  });
  contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
}

export async function shutdownTracing(): Promise<void> {
  if (!provider) {
    return;
  }
  await provider.shutdown();
  trace.disable();
  propagation.disable();
  context.disable();
  contextManager?.disable();
  provider = undefined;
  contextManager = undefined;
}

export function tracer() {
  return trace.getTracer('wagering-service');
}

export function injectTraceHeaders(source: Context = context.active()): TraceHeaders {
  const headers: TraceHeaders = {};
  propagation.inject(source, headers);
  return headers;
}

export function extractTraceContext(headers: Record<string, string | undefined>): Context {
  return propagation.extract(context.active(), headers);
}

export function currentTraceIds(): { traceId: string; spanId: string } | undefined {
  const span = trace.getActiveSpan();
  const spanContext = span?.spanContext();
  if (!spanContext || !span?.isRecording()) {
    return undefined;
  }
  return { traceId: spanContext.traceId, spanId: spanContext.spanId };
}

export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  work: (span: Span) => Promise<T>,
  options: { kind?: SpanKind; parent?: Context } = {},
): Promise<T> {
  return tracer().startActiveSpan(
    name,
    { kind: options.kind ?? SpanKind.INTERNAL, attributes },
    options.parent ?? context.active(),
    async (span) => {
      try {
        return await work(span);
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

export { SpanKind, SpanStatusCode };
