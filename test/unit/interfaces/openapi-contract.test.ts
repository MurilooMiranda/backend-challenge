import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DocsController, loadOpenApiSpec } from '@/interfaces/http/docs.controller';
import { HealthController } from '@/interfaces/http/health.controller';
import { LedgerController } from '@/interfaces/http/ledger.controller';
import { MetricsController } from '@/interfaces/http/metrics.controller';
import { WageringController } from '@/interfaces/http/wagering.controller';
import { WalletsController } from '@/interfaces/http/wallets.controller';

const CONTROLLERS = [
  HealthController,
  MetricsController,
  WalletsController,
  WageringController,
  LedgerController,
  DocsController,
];

type Spec = {
  paths: Record<string, Record<string, { operationId?: string; responses?: object }>>;
  components: { schemas: Record<string, unknown> };
};

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function join(...parts: string[]): string {
  const path = parts
    .flatMap((part) => part.split('/'))
    .filter(Boolean)
    .map((segment) => (segment.startsWith(':') ? `{${segment.slice(1)}}` : segment))
    .join('/');
  return `/${path}`;
}

function implementedRoutes(): string[] {
  return CONTROLLERS.flatMap((controller) => {
    const base = (Reflect.getMetadata(PATH_METADATA, controller) as string | undefined) ?? '';
    const prototype: object = controller.prototype;
    return Object.getOwnPropertyNames(prototype)
      .map((name): unknown => Reflect.get(prototype, name))
      .filter((handler): handler is object => typeof handler === 'function')
      .filter((handler) => Reflect.hasMetadata(METHOD_METADATA, handler))
      .map((handler) => {
        const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];
        const path = Reflect.getMetadata(PATH_METADATA, handler) as string;
        return `${method!.toUpperCase()} ${join(base, path)}`;
      });
  }).sort();
}

function documentedRoutes(spec: Spec): string[] {
  return Object.entries(spec.paths)
    .flatMap(([path, operations]) =>
      Object.keys(operations)
        .filter((method) => HTTP_METHODS.includes(method))
        .map((method) => `${method.toUpperCase()} ${path}`),
    )
    .sort();
}

describe('OpenAPI contract', () => {
  const spec = loadOpenApiSpec() as unknown as Spec;

  it('documents exactly the routes the application exposes', () => {
    expect(documentedRoutes(spec)).toEqual(implementedRoutes());
  });

  it('gives every operation a unique operationId and at least one response', () => {
    const operations = Object.values(spec.paths).flatMap((ops) =>
      Object.entries(ops)
        .filter(([method]) => HTTP_METHODS.includes(method))
        .map(([, op]) => op),
    );
    const ids = operations.map((op) => op.operationId);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(operations.every((op) => Object.keys(op.responses ?? {}).length > 0)).toBe(true);
  });

  it('resolves every local $ref', () => {
    const refs = [...JSON.stringify(spec).matchAll(/"\$ref":"#\/([^"]+)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const target = ref
        .split('/')
        .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], spec);
      expect(target, ref).toBeDefined();
    }
  });

  it('documents every failure code the domain can produce', async () => {
    const { FailureCode } = await import('@/domain/wagering/failure-code');
    const documented = (spec.components.schemas.FailureCode as { enum: string[] }).enum;
    expect([...documented].sort()).toEqual(Object.values(FailureCode).sort());
  });
});
