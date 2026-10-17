# 13. Autenticação com Keycloak (OIDC, client credentials)

Data: 2026-10-15

## Status

Aceito

## Contexto

Os clientes da API são sistemas (provedores de jogos e um back office), não pessoas. Cada provedor só pode submeter e consultar as próprias transações. Gerenciar credenciais e emitir tokens dentro do próprio serviço seria reinventar um Identity Provider.

## Decisão

- Keycloak como Identity Provider, realm `wagering` importado no start do container.
- Um client por provedor e um client `backoffice`, todos com o fluxo `client_credentials`.
- Tokens com audiência `wagering-api`, papéis em `realm_access.roles` (`provider`, `operator`) e a claim `provider_id` fixada por client.
- Validação local do JWT com `jose`: RS256 contra o JWKS em cache, `iss`, `aud` e `exp`. Sem chamada ao IdP por requisição.
- Autorização na aplicação: o `providerId` do corpo precisa ser o do token (`403`); transações de outro provedor respondem `404`.
- JWKS inalcançável responde `503`, não `401`: falha do IdP não é culpa do cliente.

## Alternativas consideradas

- **API keys próprias numa tabela.** Simples, mas sem rotação, expiração nem padrão de mercado.
- **Introspecção do token a cada requisição.** Revogação imediata, mas o IdP vira dependência síncrona de toda requisição.
- **mTLS entre provedores e o serviço.** Forte, mas operacionalmente pesado para o escopo.

## Consequências

- O serviço não guarda credenciais. Rotacionar segredos e chaves é feito no Keycloak.
- Um token continua válido até expirar, mesmo se o client for desativado.
- Em desenvolvimento e nos testes, `AUTH_ENABLED=false` injeta um principal irrestrito; os testes de autenticação usam um emissor JWKS local.
