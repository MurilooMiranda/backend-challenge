import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import { type Principal, Role, type TokenVerifier, UnauthenticatedError } from '@/application/auth';
import { InfrastructureUnavailableError } from '@/application/errors';

export interface JwtVerifierConfig {
  issuer: string;
  audience: string;
  jwksUrl: string;
  providerClaim: string;
}

export function readJwtVerifierConfig(): JwtVerifierConfig {
  const required = (name: string) => {
    const value = process.env[name];
    if (!value) {
      throw new Error(`${name} is required when AUTH_ENABLED=true`);
    }
    return value;
  };
  return {
    issuer: required('AUTH_ISSUER'),
    audience: required('AUTH_AUDIENCE'),
    jwksUrl: required('AUTH_JWKS_URL'),
    providerClaim: process.env.AUTH_PROVIDER_CLAIM ?? 'provider_id',
  };
}

const KNOWN_ROLES = new Set<string>(Object.values(Role));

const UNAVAILABLE_CODES = new Set(['ERR_JWKS_TIMEOUT', 'ERR_JWKS_INVALID']);

export class JwtTokenVerifier implements TokenVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly config: JwtVerifierConfig) {
    this.jwks = createRemoteJWKSet(new URL(config.jwksUrl), {
      timeoutDuration: 2_000,
      cooldownDuration: 30_000,
    });
  }

  async verify(token: string): Promise<Principal> {
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: ['RS256'],
      }));
    } catch (error) {
      if (error instanceof errors.JOSEError && !UNAVAILABLE_CODES.has(error.code)) {
        throw new UnauthenticatedError(error.code);
      }
      throw new InfrastructureUnavailableError(
        `identity provider keys unavailable: ${(error as Error).message}`,
      );
    }

    const realmAccess = payload.realm_access as { roles?: unknown } | undefined;
    const roles = (Array.isArray(realmAccess?.roles) ? realmAccess.roles : [])
      .filter((role): role is string => typeof role === 'string' && KNOWN_ROLES.has(role))
      .map((role) => role as Role);

    const claim = payload[this.config.providerClaim];
    const providerId = typeof claim === 'string' && claim.trim() !== '' ? claim : undefined;
    if (roles.includes(Role.Provider) && !roles.includes(Role.Operator) && !providerId) {
      throw new UnauthenticatedError(`provider token without "${this.config.providerClaim}" claim`);
    }

    const subject =
      (typeof payload.sub === 'string' && payload.sub) ||
      (typeof payload.azp === 'string' && payload.azp) ||
      'unknown';

    return {
      subject,
      roles,
      ...(providerId ? { providerId } : {}),
      unrestricted: roles.includes(Role.Operator),
    };
  }

  async ping(): Promise<void> {
    const response = await fetch(this.config.jwksUrl, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) {
      throw new Error(`JWKS endpoint answered ${response.status}`);
    }
  }
}
