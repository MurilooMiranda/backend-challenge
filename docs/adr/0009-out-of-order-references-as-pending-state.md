# 9. Referências fora de ordem como estado `PENDING_REFERENCE`

Data: 2026-10-15

## Status

Aceito

## Contexto

Um `REFUND` ou `ROLLBACK` pode chegar antes da aposta que ele referencia: filas diferentes, retries, ou HTTP e SQS concorrendo. Rejeitar de imediato forçaria o provedor a reenviar; aceitar sem a referência permitiria estornar algo que nunca existiu.

## Decisão

- Se a referência não existe, ou ainda não é terminal, a transação é persistida como `PENDING_REFERENCE`, com `next_reference_check_at`, e a resposta é `202`.
- Um worker em cada instância busca as transações vencidas, trava a wallet e reaplica a mesma regra de domínio. O lock da wallet serializa instâncias que tentem a mesma transação.
- Política: até 10 tentativas, backoff exponencial de 2 s até 5 min (cerca de 18 min no total). Esgotado o limite: `REJECTED` com `REFERENCE_NOT_FOUND`.
- `WagerTransactionPendingReference` é publicado só na primeira transição.

## Alternativas consideradas

- **Rejeitar imediatamente.** Simples, mas transfere ao provedor um problema de ordenação que é nosso.
- **Devolver a mensagem à fila até a referência chegar.** Não cobre o HTTP, consome tentativas da redrive policy e bloquearia o grupo FIFO da wallet.
- **Espera ilimitada.** Transações penduradas para sempre e saldo incerto para o jogador.

## Consequências

- Mensagens fora de ordem se resolvem sozinhas em segundos no caso comum.
- O provedor recebe `202` e precisa consultar o estado final, ou consumir o evento `WagerTransactionProcessed`/`Rejected`.
- Existe um estado intermediário a mais na máquina de estados, coberto por testes de domínio, de integração e com três instâncias.
