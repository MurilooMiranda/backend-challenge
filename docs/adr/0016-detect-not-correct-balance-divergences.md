# 16. Reconciliação periódica que detecta e não corrige divergências

Data: 2026-10-16

## Status

Aceito

## Contexto

Os triggers do banco ([ADR 0006](0006-enforce-ledger-invariants-in-the-database.md)) impedem divergência entre saldo, ledger e razão em qualquer escrita normal. Uma intervenção manual com os triggers desligados, um restore parcial ou um bug no próprio banco ainda poderiam produzir uma divergência, e a reconciliação sob demanda só a encontraria se alguém consultasse aquela wallet.

## Decisão

- Um worker reconcilia **todas** as wallets a cada `RECONCILIATION_INTERVAL_MS` (padrão 5 min), comparando o saldo armazenado com o subledger e com a conta do jogador no razão.
- A varredura roda numa única transação `REPEATABLE READ READ ONLY`, em lotes por keyset (`id > último`). Todos os lotes enxergam o mesmo snapshot, e nenhuma escrita é bloqueada.
- `pg_try_advisory_xact_lock` garante uma varredura por vez no cluster; as outras instâncias pulam a rodada. O lock é liberado no fim da transação, inclusive se o processo morrer.
- Divergências são **detectadas e não corrigidas**: viram log de erro, a métrica `wallet_reconciliation_divergent_wallets` e o alerta crítico `WalletBalanceDivergence`.

## Alternativas consideradas

- **Corrigir automaticamente o saldo.** Esconderia o bug que causou a divergência e reescreveria um histórico financeiro que precisa ser auditável. A correção é uma decisão humana, feita com um lançamento de ajuste.
- **Todas as instâncias varrendo.** Trabalho triplicado sem ganho.
- **Lock de tabela ou `SERIALIZABLE`.** Bloquearia ou abortaria escritas durante a varredura.

## Consequências

- Uma divergência é detectada em no máximo um intervalo, independentemente de alguém consultar a wallet.
- O alerta `ReconciliationStale` cobre o caso de o próprio worker parar.
- A varredura é linear no tamanho do ledger. Em escala, seria incremental (só wallets alteradas desde o último checkpoint) e somaria a partir de saldos fechados por período.
