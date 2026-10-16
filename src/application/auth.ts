import { ApplicationError } from './errors';

export enum Role {
  Provider = 'provider',
  Operator = 'operator',
}

export interface Principal {
  subject: string;
  roles: Role[];
  providerId?: string;
  unrestricted: boolean;
}

export interface TokenVerifier {
  verify(token: string): Promise<Principal>;
  ping?(): Promise<void>;
}

export const TOKEN_VERIFIER = Symbol('TokenVerifier');

export const ANONYMOUS_PRINCIPAL: Principal = Object.freeze({
  subject: 'anonymous',
  roles: [Role.Provider, Role.Operator],
  unrestricted: true,
});

export class UnauthenticatedError extends ApplicationError {
  readonly code = 'UNAUTHENTICATED';

  constructor(reason: string) {
    super(`Authentication required: ${reason}`);
  }
}

export class ForbiddenError extends ApplicationError {
  readonly code = 'FORBIDDEN';

  constructor(reason: string) {
    super(`Forbidden: ${reason}`);
  }
}

export function assertProviderAccess(principal: Principal, providerId: string): void {
  if (!principal.unrestricted && principal.providerId !== providerId) {
    throw new ForbiddenError(`token is not allowed to act as provider "${providerId}"`);
  }
}

export function canSeeProvider(principal: Principal, providerId: string): boolean {
  return principal.unrestricted || principal.providerId === providerId;
}
