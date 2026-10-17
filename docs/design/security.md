# Autenticação e autorização

> Decisão relacionada: [ADR 0013](../adr/0013-keycloak-oidc-client-credentials.md).

A autenticação não vale pontos na avaliação, então foi implementada depois que correção, concorrência e mensageria estavam prontas e testadas. O Identity Provider é o **Keycloak** (OIDC); não há tabela de usuários nem senha própria.

## Modelo

- **Um client por provedor de jogos** (`provider-a`, `provider-b`) e um client `backoffice`, todos com `client_credentials` (comunicação máquina a máquina). O realm é importado no start do container a partir de `docker/keycloak/realm`.
- Cada token de provedor carrega a claim `provider_id` (mapper fixo por client) e a audiência `wagering-api` (audience mapper). Os papéis `provider` e `operator` vêm de `realm_access.roles`.

| Client       | Papel      | `provider_id` |
| ------------ | ---------- | ------------- |
| `provider-a` | `provider` | `provider-a`  |
| `provider-b` | `provider` | `provider-b`  |
| `backoffice` | `operator` | —             |

## Validação do token

A aplicação valida o JWT localmente com `jose` (`src/infrastructure/auth/jwt-token-verifier.ts`): assinatura RS256 contra o JWKS do Keycloak (em cache, com cooldown entre buscas), `iss`, `aud` e expiração. Não há chamada ao IdP por requisição, então o Keycloak fora do ar não derruba requisições com chaves já em cache.

A porta da aplicação é `TokenVerifier` → `Principal` (`roles`, `providerId`, `unrestricted`). O `AuthGuard` só traduz HTTP para essa porta; as regras de autorização ficam em `src/application/auth.ts` (`assertProviderAccess` e `canSeeProvider`).

## Autorização

| Endpoint                                          | Quem acessa                                                                            |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `POST /wagering/transactions`                     | `provider`, somente com o próprio `providerId` no corpo (senão `403`)                  |
| `GET /wagering/transactions/:id`                  | `provider` (só transações do próprio provedor; as demais respondem `404`) e `operator` |
| `GET /providers/:providerId/...`                  | `provider` do mesmo `providerId` e `operator`                                          |
| `GET /wallets/:id`                                | `provider` e `operator`                                                                |
| `POST /wallets`, ledger, reconciliação, balancete | `operator`                                                                             |
| `/health/*`, `/metrics`, `/docs`                  | abertos                                                                                |

Transações de outro provedor respondem `404`, não `403`, para não revelar que existem.

## Falhas

| Situação                                                                               | Resposta                                                 |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Sem token, token inválido, expirado, de outro emissor ou audiência, chave desconhecida | `401` + `WWW-Authenticate`                               |
| Papel insuficiente ou `providerId` de outro provedor                                   | `403`                                                    |
| JWKS inalcançável                                                                      | `503` (transitório; falha do IdP não é culpa do cliente) |

O `/health/ready` passa a verificar o JWKS quando a autenticação está ligada.

## Fronteiras de confiança

- A fila SQS é tratada como canal interno confiável, como o enunciado define, e as mensagens não carregam token. O `providerId` delas continua sujeito às validações de domínio. Em produção, o acesso à fila seria restrito por IAM.
- Em desenvolvimento e nos testes que não tratam de autenticação, `AUTH_ENABLED=false` injeta um principal irrestrito. O profile `app` do compose liga a autenticação.
- `/metrics` e `/docs` são abertos para facilitar a avaliação; em produção ficariam atrás da rede interna.

## Testes

`test/integration/auth.test.ts` sobe um emissor JWKS local com chaves RSA próprias, de modo que o caminho de verificação é o mesmo usado com o Keycloak. `bun run auth:smoke` valida a integração real contra o container.
