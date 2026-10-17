# 17. Contrato OpenAPI escrito à mão e verificado contra as rotas

Data: 2026-10-16

## Status

Aceito

## Contexto

Provedores integram pela API HTTP e precisam de um contrato navegável. A forma mais comum no NestJS é gerar a especificação a partir de decorators (`@nestjs/swagger`), mas os controllers validam com zod e recebem `unknown`, então os decorators seriam uma segunda descrição do mesmo contrato, espalhada pelo código e sem nada que garanta que ela bate com a validação real.

## Decisão

- A especificação OpenAPI 3.1 é um arquivo versionado, `docs/api/openapi.yaml`, escrito à mão (spec-first). Ela documenta também o que decorators não capturam bem: semântica de idempotência, status por resultado de negócio, papéis exigidos (`x-required-roles`) e exemplos.
- A aplicação serve a especificação em `/docs/openapi.json` e o Swagger UI em `/docs`.
- Um teste unitário compara as rotas registradas no Nest com as da especificação, nos dois sentidos, e verifica `operationId` únicos, `$ref` resolvíveis e a lista de `failureCode`. O CI falha se o contrato e o código divergirem.
- O lado assíncrono (filas e eventos) é documentado em `docs/api/messaging.md`.

## Alternativas consideradas

- **`@nestjs/swagger` com decorators.** Gera a especificação automaticamente, mas duplica os schemas zod em decorators e polui os controllers.
- **Gerar OpenAPI a partir dos schemas zod.** Bom para os corpos, mas não cobre status codes, headers e a semântica de cada resposta.
- **AsyncAPI para os eventos.** Seria o padrão equivalente para mensageria; com quatro eventos, uma página em Markdown é suficiente por enquanto.

## Consequências

- O contrato é revisado em pull request como qualquer código, e uma rota não documentada quebra o CI.
- O teste verifica a existência das rotas, não cada campo dos schemas; mudanças de corpo ainda dependem de revisão.
- O Swagger UI é carregado de CDN, então a página `/docs` precisa de acesso à internet no navegador.
