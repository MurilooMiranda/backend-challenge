# 6. Garantir as invariantes do ledger no banco

Data: 2026-10-14

## Status

Aceito

## Contexto

O domínio já valida saldo, ledger e estados antes de gravar. Mas a validação em código só protege o caminho que passa pelo código: um bug futuro, um script de correção manual ou um segundo serviço escrevendo nas mesmas tabelas podem gravar um estado que o domínio nunca permitiria. Num sistema financeiro, o ledger precisa continuar correto mesmo nesses casos.

## Decisão

Duplicar as invariantes críticas no PostgreSQL, como última linha de defesa:

- `CHECK` para saldo não negativo, aritmética de cada lançamento (`before ± amount = after`) e coerência de status, `failure_code` e `processed_at`;
- trigger `BEFORE INSERT` que exige que `balance_before` seja o `balance_after` do lançamento anterior (ledger em corrente, sem buracos);
- triggers que bloqueiam `UPDATE` e `DELETE` no ledger e em transações terminais;
- **constraint trigger deferida** (`DEFERRABLE INITIALLY DEFERRED`) que verifica, no COMMIT, que o saldo da wallet é o último `balance_after` do ledger;
- `UNIQUE` para idempotência, para uma reversão por referência (índice parcial) e para um lançamento por transação;
- FKs compostas com a moeda, para impedir lançamento numa moeda diferente da wallet.

## Alternativas consideradas

- **Só validação no domínio.** Mais simples, mas não protege contra escrita fora do caminho feliz.
- **Saldo calculado sempre a partir do ledger (sem coluna de saldo).** Elimina a divergência, mas cada aposta precisaria somar o histórico inteiro da wallet sob lock.

## Consequências

- Divergência entre saldo e ledger passa a ser impossível sem desligar os triggers. `test/integration/schema.test.ts` tenta violar cada regra com SQL puro.
- As migrations precisam ser escritas em SQL à mão (ver [ADR 0007](0007-mikroorm-with-hand-written-sql-migrations.md)).
- Cada INSERT no ledger faz uma leitura indexada do lançamento anterior: custo pequeno, mas medido.
- A regra existe em dois lugares (domínio e banco). Os testes de schema garantem que as duas continuam de acordo.
