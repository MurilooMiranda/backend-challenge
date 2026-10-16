import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  ANONYMOUS_PRINCIPAL,
  ForbiddenError,
  type Principal,
  type Role,
  TOKEN_VERIFIER,
  type TokenVerifier,
  UnauthenticatedError,
} from '@/application/auth';
import { addLogContext } from '@/infrastructure/observability/log-context';

export const AUTH_ENABLED = Symbol('AuthEnabled');

const ROLES_KEY = 'wagering:roles';

export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

type AuthenticatedRequest = Request & { principal?: Principal };

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().principal ?? ANONYMOUS_PRINCIPAL,
);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AUTH_ENABLED) private readonly enabled: boolean,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!this.enabled) {
      request.principal = ANONYMOUS_PRINCIPAL;
      return true;
    }

    const header = request.header('authorization') ?? '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) {
      throw new UnauthenticatedError('missing bearer token');
    }

    const principal = await this.verifier.verify(match[1]!);
    request.principal = principal;
    addLogContext({ principal: principal.subject });

    const required =
      this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    if (required.length > 0 && !required.some((role) => principal.roles.includes(role))) {
      throw new ForbiddenError(`requires one of the roles: ${required.join(', ')}`);
    }
    return true;
  }
}
