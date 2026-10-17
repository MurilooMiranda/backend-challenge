# 4. Serializar operações por wallet com lock pessimista de linha

Data: 2026-10-14

## Status

Aceito

## Contexto

Várias instâncias recebem, por HTTP e por SQS, transações para a mesma wallet ao mesmo tempo. O padrão ingênuo `ler saldo → calcular → gravar` perde atualizações. O enunciado exige que duas apostas de 80.00 sobre um saldo de 100.00 resultem em exatamente uma aceita, e proíbe lock global.

## Decisão

A unidade de concorrência é a wallet. Cada transação abre uma transação SQL, executa `SELECT ... FOR UPDATE` na linha da wallet, decide com o saldo lido sob o lock e grava tudo antes do COMMIT.

- Operações da mesma wallet são serializadas em qualquer instância; wallets diferentes não disputam.
- A busca de idempotência acontece antes do lock (replays não entram na fila) e de novo depois dele.
- Conflitos que o lock não cobre (a mesma chave de idempotência apontando para wallets diferentes) são resolvidos pelo `UNIQUE` do banco: o caso de uso captura a violação e refaz a operação, até 3 vezes.
- A conta contábil da casa é garantida **antes** de travar a wallet, para não alongar a seção crítica.

## Alternativas consideradas

- **Optimistic locking (`version` + retry).** Correto, mas numa wallet "quente" (muitas apostas simultâneas do mesmo jogador) gera tempestades de retry, com latência imprevisível e trabalho desperdiçado. O lock pessimista transforma contenção em uma fila curta e ordenada.
- **`UPDATE wallets SET balance = balance - x WHERE balance >= x`.** Atômico para o saldo, mas a decisão de negócio (referências, reversões, estados) precisa de mais contexto do que cabe num `WHERE`, e o ledger em corrente precisa do saldo anterior exato.
- **Serializar pela fila (FIFO por wallet).** Não cobre o HTTP, que concorre com a fila. A ordenação FIFO continua sendo usada, mas como otimização, não como garantia.
- **Isolamento `SERIALIZABLE`.** Funciona, mas gera falhas de serialização também entre wallets diferentes que compartilham páginas de índice, exigindo retry genérico.

## Consequências

- Correção simples de demonstrar: o teste das 50 requisições paralelas e o das apostas de 80.00 passam em uma e em três instâncias.
- O throughput de uma única wallet é limitado pela serialização; o tempo de espera é exposto em `wallet_lock_wait_seconds` e no alerta `WalletLockContention`.
- Cada transação mantém uma conexão durante a seção crítica, que por isso é mantida curta.
