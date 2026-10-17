# 8. Transactional outbox para eventos e inbox para mensagens recebidas

Data: 2026-10-15

## Status

Aceito

## Contexto

Cada mudança de saldo precisa publicar eventos de integração. Publicar direto no SQS dentro do caso de uso cria o problema de dual write: se o envio acontece antes do commit e a transação falha, o evento descreve algo que não aconteceu; se acontece depois e o processo cai, o evento se perde. Do lado da entrada, o SQS entrega at-least-once, e a mesma mensagem pode ser processada duas vezes.

## Decisão

**Outbox.** Os eventos são gravados em `outbox_messages` na mesma transação SQL da mudança financeira. Um publisher em cada instância os envia ao SQS depois do commit:

- seleção com `FOR UPDATE SKIP LOCKED`, para vários publishers em paralelo sem disputa;
- reivindicação por wallet: trava a mensagem mais antiga pendente de uma wallet e leva as seguintes, até 20, em ordem. Isso preserva a ordem por wallet mesmo com falhas e publishers concorrentes;
- envio com `SendMessageBatch`, `MessageGroupId = walletId` e `MessageDeduplicationId = eventId`;
- falha de envio: backoff de 1 s a 60 s, e as mensagens seguintes da mesma wallet esperam.

**Inbox.** O consumidor grava `(consumerName, messageId)` na mesma transação da mudança financeira e só faz `DeleteMessage` depois do commit. Uma redelivery é reconhecida e vira replay.

## Alternativas consideradas

- **Publicar depois do commit, sem outbox.** Perde eventos se o processo cair entre o commit e o envio.
- **CDC (Debezium lendo o WAL).** Elimina o polling, mas exige Kafka Connect ou similar, o que é desproporcional para o escopo.
- **Publisher sem ordem por wallet (só `SKIP LOCKED` por linha).** Mais throughput, mas dois publishers poderiam publicar eventos da mesma wallet fora de ordem.

## Consequências

- Nenhum evento de algo que sofreu rollback; nenhum evento perdido. A entrega é at-least-once, e consumidores deduplicam por `eventId`.
- O publisher mantém o lock durante o envio ao SQS, o que prende uma conexão pelo tempo de rede. O teste de carga levou a duas otimizações (lotes por wallet e `SendMessageBatch`) que reduziram o atraso da outbox de 27 s para menos de 1 s.
- As tabelas crescem continuamente; a retenção está em [ADR 0015](0015-bounded-retention-for-inbox-and-outbox.md).
