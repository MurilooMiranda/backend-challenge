# 5. Idempotência por chave com hash canônico do payload

Data: 2026-10-14

## Status

Aceito

## Contexto

Provedores reenviam transações (timeout, retry, redelivery do SQS). Um reenvio não pode debitar duas vezes. Ao mesmo tempo, um provedor com bug pode reutilizar a mesma chave para uma transação diferente, e responder "ok, já processado" nesse caso esconderia o erro e perderia a transação nova.

## Decisão

- `Idempotency-Key` é obrigatória (header no HTTP, `data.idempotencyKey` na fila).
- Cada transação guarda `payloadHash`: SHA-256 do JSON canônico (chaves ordenadas, sem espaços, `undefined` omitido) apenas dos campos de negócio. Header, `correlationId` e metadados de transporte ficam de fora, então o mesmo pedido por HTTP e por SQS tem o mesmo hash.
- Mesma chave e mesmo hash: **replay** do resultado original, inclusive o saldo observado na época e o status (uma rejeição continua rejeição).
- Mesma chave com outro hash, ou mesmo `(providerId, externalTransactionId)` com outra chave: **`409 IDEMPOTENCY_CONFLICT`**.
- As duas condições são `UNIQUE` no banco e são buscadas numa única consulta.
- Na fila, a inbox `(consumerName, messageId)` também é gravada na mesma transação.

## Alternativas consideradas

- **Cache de idempotência em memória ou Redis com TTL.** Não sobrevive a reinício (memória), adiciona uma dependência e uma janela de inconsistência entre cache e banco (Redis). O banco já é transacional com a mudança de saldo.
- **Deduplicar só por `externalTransactionId`.** Não detecta payload diferente com o mesmo id.
- **Hash do corpo bruto.** Instável: ordem de chaves e espaços mudariam o hash para o mesmo pedido.

## Consequências

- Reenvios são seguros por qualquer canal e em qualquer instância, sem estado em memória.
- Uma race real foi encontrada e corrigida por causa desta decisão: com duas consultas separadas (por chave e por id externo), um commit concorrente entre elas gerava falso conflito.
- Mudar a lista de campos do hash é uma mudança incompatível: chaves antigas passariam a conflitar.
