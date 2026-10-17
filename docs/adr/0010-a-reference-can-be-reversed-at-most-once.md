# 10. Uma transação pode ser revertida no máximo uma vez, por qualquer tipo

Data: 2026-10-14

## Status

Aceito

## Contexto

O enunciado diz que uma transação não pode ser revertida duas vezes "pelo mesmo tipo de operação". Lido ao pé da letra, um `REFUND` e depois um `ROLLBACK` da mesma `BET` seriam permitidos, e o jogador receberia o valor da aposta de volta duas vezes.

## Decisão

Uma transação de referência pode ser alvo de **no máximo uma reversão processada**, seja `REFUND` ou `ROLLBACK`. A segunda é rejeitada com `ALREADY_REVERSED`. A regra é garantida no domínio e por um índice único parcial em `reference_transaction_id` para `REFUND`/`ROLLBACK` com status `PROCESSED`.

Desfazer uma reversão continua possível: um `ROLLBACK` cuja referência é o próprio `REFUND`.

## Alternativas consideradas

- **Interpretação literal (uma reversão por tipo).** Permite crédito em dobro, um prejuízo direto para a casa.

## Consequências

- Nenhuma combinação de reversões credita a mesma aposta duas vezes. O teste de propriedades gera sequências aleatórias de reversões e verifica isso.
- A interpretação está documentada na API e na [regra de negócio](../design/business-rules.md), porque um provedor que espere o comportamento literal receberá `ALREADY_REVERSED`.
