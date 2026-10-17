# 12. Razão geral de partidas dobradas ao lado do ledger da wallet

Data: 2026-10-15

## Status

Aceito

## Contexto

O ledger da wallet registra cada movimentação do jogador, mas não responde para onde o dinheiro foi: quanto cada provedor recebeu em apostas e pagou em prêmios, e se o sistema como um todo fecha. Sistemas financeiros respondem isso com contabilidade de partidas dobradas, em que todo lançamento tem débitos e créditos iguais.

## Decisão

- Manter o ledger da wallet como **subledger** do jogador e adicionar um **razão geral**: `ledger_accounts` (plano de contas), `journal_entries` e `journal_postings`.
- Contas: `PLAYER:<walletId>`, `HOUSE:<providerId>:<moeda>` e `FUNDING:<moeda>` (contrapartida do saldo inicial).
- Toda movimentação gera, na mesma transação SQL, um lançamento com dois postings que se anulam.
- Constraint triggers deferidas garantem, no COMMIT, que débitos = créditos em cada lançamento e que o subledger e a conta do jogador no razão têm exatamente os mesmos movimentos.
- As contas da casa e de funding **não têm saldo materializado**; o saldo é a soma dos postings. São criadas sob demanda com `INSERT … ON CONFLICT DO NOTHING`.
- `GET /ledger/trial-balance` expõe o balancete.

## Alternativas consideradas

- **Saldo materializado nas contas da casa.** Toda aposta de um provedor travaria a mesma linha: um lock global, que o enunciado proíbe.
- **Substituir o ledger da wallet pelo razão.** Perderia o encadeamento `balance_before`/`balance_after` por wallet, que torna a auditoria do jogador simples.

## Consequências

- O balancete sempre fecha, e a reconciliação compara três fontes independentes: saldo, subledger e razão.
- Custo medido de cerca de 25–30% do throughput no teste de carga.
- O balancete varre todos os postings da moeda; em produção, seria substituído por saldos fechados por período.
- A migration fez o backfill dos lançamentos que já existiam.
