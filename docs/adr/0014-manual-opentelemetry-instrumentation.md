# 14. Instrumentação manual com OpenTelemetry e contexto de trace na outbox

Data: 2026-10-16

## Status

Aceito

## Contexto

Uma transação atravessa HTTP ou SQS, o banco, a outbox e outra fila, em instâncias diferentes. Logs com `correlationId` mostram cada parte, mas não o tempo gasto em cada etapa (espera de lock, publicação). A instrumentação automática do OpenTelemetry para Node depende de hooks de `require` que não funcionam de forma confiável no Bun.

## Decisão

- Instrumentação manual com a API do OpenTelemetry e exportação OTLP/HTTP (Jaeger no compose), ligada por `OTEL_ENABLED`.
- Spans para a requisição HTTP (continuando um `traceparent` recebido), a transação de banco, a espera pelo lock da wallet, a publicação de cada evento e o consumo de cada mensagem.
- O contexto do trace é gravado na outbox, na coluna `headers`, na mesma transação do evento, e enviado como atributo `traceparent` da mensagem SQS. Para o domínio, é um metadado de transporte opaco.
- Logs dentro de um span carregam `traceId` e `spanId`; respostas HTTP trazem `x-trace-id`.

## Alternativas consideradas

- **Auto-instrumentação.** Não funciona de forma confiável no Bun.
- **Só correlationId nos logs.** Não mostra latência por etapa nem a ligação entre a requisição e a publicação assíncrona.

## Consequências

- Um único trace mostra a requisição, a espera do lock e a publicação do evento, mesmo que a publicação aconteça em outra instância.
- Cada novo ponto de I/O precisa ser instrumentado à mão.
- Desligado, o custo é praticamente zero (API no-op).
