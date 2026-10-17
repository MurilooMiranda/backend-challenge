# 15. Retenção limitada para inbox e outbox

Data: 2026-10-16

## Status

Aceito

## Contexto

Inbox e outbox ([ADR 0008](0008-transactional-outbox-and-inbox.md)) recebem linhas a cada transação e nunca eram limpas. As tabelas cresceriam sem limite, deixando mais lentos o claim da outbox e a busca na inbox. Por outro lado, a inbox é o que torna o consumo idempotente por `messageId`: apagar cedo demais permitiria reprocessar uma redelivery tardia.

## Decisão

- Um worker por instância (a cada `RETENTION_INTERVAL_MS`, padrão 10 min) apaga a outbox **publicada** há mais de `OUTBOX_RETENTION_HOURS` (72 h) e a inbox **processada** há mais de `INBOX_RETENTION_DAYS` (7 dias). Linhas pendentes nunca são apagadas.
- Lotes de `RETENTION_BATCH_SIZE` (1000) com `DELETE … WHERE id IN (SELECT … LIMIT n FOR UPDATE SKIP LOCKED)`: transações curtas, sem disputa entre instâncias nem com o publisher. O worker repete enquanto o lote vier cheio.
- Índices parciais em `published_at` e `processed_at`, só para as linhas elegíveis.

## Alternativas consideradas

- **Particionar por tempo e descartar partições.** Mais barato em volume muito alto (sem bloat nem vacuum), mas exige gestão de partições; é o próximo passo se o volume justificar.
- **`DELETE` único sem lote.** Uma transação longa, com muitos locks e WAL de uma vez.
- **Cron externo (pg_cron).** Mais uma peça de infraestrutura; o worker reaproveita o ciclo de vida que a aplicação já tem.

## Consequências

- As tabelas ficam limitadas ao volume da janela de retenção.
- A janela da inbox precisa continuar bem maior que qualquer reentrega possível do SQS. Mesmo depois dela, a chave de idempotência em `wager_transactions`, que nunca é apagada, impede efeito financeiro duplicado.
- O histórico de eventos publicados fica disponível por 72 h para diagnóstico; por mais tempo, ele deve ser guardado pelos consumidores.
