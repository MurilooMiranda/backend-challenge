import { type CryptoKey, SignJWT, exportJWK, generateKeyPair } from 'jose';

export interface TokenOptions {
  roles?: string[];
  providerId?: string;
  audience?: string;
  issuer?: string;
  expiresIn?: string;
  signWith?: CryptoKey;
}

export interface TestIssuer {
  issuer: string;
  audience: string;
  jwksUrl: string;
  token(options?: TokenOptions): Promise<string>;
  foreignKey(): Promise<CryptoKey>;
  stop(): Promise<void>;
}

export async function startTestIssuer(): Promise<TestIssuer> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ keys: [jwk] }),
  });
  const issuer = 'http://localhost:8080/realms/wagering';
  const audience = 'wagering-api';

  return {
    issuer,
    audience,
    jwksUrl: `http://localhost:${server.port}/realms/wagering/protocol/openid-connect/certs`,
    async token(options: TokenOptions = {}) {
      return new SignJWT({
        realm_access: { roles: options.roles ?? [] },
        ...(options.providerId ? { provider_id: options.providerId } : {}),
        azp: options.providerId ?? 'backoffice',
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setSubject(`service-account-${options.providerId ?? 'backoffice'}`)
        .setIssuer(options.issuer ?? issuer)
        .setAudience(options.audience ?? audience)
        .setIssuedAt()
        .setExpirationTime(options.expiresIn ?? '5m')
        .sign(options.signWith ?? privateKey);
    },
    async foreignKey() {
      return (await generateKeyPair('RS256')).privateKey;
    },
    async stop() {
      await server.stop(true);
    },
  };
}
