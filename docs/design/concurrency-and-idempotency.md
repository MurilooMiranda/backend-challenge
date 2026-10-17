# Concorrência e idempotência

> Decisões relacionadas: [ADR 0004](../adr/0004-serialize-wallet-operations-with-pessimistic-row-locks.md) (lock por wallet) e [ADR 0005](../adr/0005-idempotency-key-with-canonical-payload-hash.md) (idempotência).

## Fluxo de uma transação

```mermaid
sequenceDiagram
  participant C as HTTP ou SQS
  participant UC as ProcessWagerTransaction
  participant DB as PostgreSQL
  C->>UC: comando (idempotencyKey, payload)
  UC->>UC: valida Money e calcula payloadHash
  UC->>DB: BEGIN
  UC->>DB: busca por idempotencyKey ou (providerId, externalTransactionId)
  alt já existe
    UC-->>C: replay (mesmo hash) ou 409 (hash diferente)
  end
  UC->>DB: garante a conta HOUSE (antes do lock da wallet)
  UC->>DB: SELECT wallet FOR UPDATE
  UC->>DB: busca de idempotência de novo (agora sob o lock)
  UC->>UC: WagerSettlement decide (domínio puro)
  UC->>DB: INSERT transação, ledger, journal, inbox, outbox; UPDATE wallet
  UC->>DB: COMMIT (triggers deferidos verificam as invariantes)
  UC-->>C: resultado
```

## Concorrência

A unidade de concorrência é a wallet. A estratégia é **lock pessimista por linha**: o caso de uso abre a transação, executa `SELECT ... FOR UPDATE` na wallet e só então decide e grava.

- Operações da mesma wallet são serializadas, em qualquer instância; wallets diferentes não disputam lock. Não existe lock global.
- O saldo é lido sob o lock e gravado na mesma transação, o que elimina o lost update do `read → calculate → update`.
- Optimistic locking também seria correto, mas numa wallet "quente" (muitas apostas simultâneas no mesmo jogador) gera tempestades de retry. O lock pessimista transforma contenção em uma fila curta e previsível. O custo é o tempo de espera do lock, exposto em `wallet_lock_wait_seconds` e no alerta `WalletLockContention`.
- `version` existe no modelo, começa em 1 e incrementa só quando o saldo muda. Serve de informação para consumidores de eventos (`walletVersion`), não como mecanismo de lock.
- A ordenação do SQS FIFO (`MessageGroupId = walletId`) reduz contenção, mas não é a garantia: HTTP e SQS concorrem pela mesma wallet, e o banco continua sendo a autoridade.

### Conflitos que o lock não resolve

A mesma chave de idempotência pode chegar apontando para **wallets diferentes** (um erro do provedor, ou um ataque). Os locks não se cruzam, então as duas transações podem passar pela checagem ao mesmo tempo. Quem resolve é o `UNIQUE` do banco: a segunda falha no INSERT. O caso de uso captura a violação de unicidade e refaz a operação inteira (até 3 tentativas, contadas em `wallet_lock_conflicts_total`). Na nova tentativa, a busca de idempotência encontra a transação vencedora e responde replay ou conflito.

## Idempotência

- `Idempotency-Key` é obrigatório no HTTP e vem em `data.idempotencyKey` na fila. É a fonte da verdade; o padrão recomendado é `{providerId}:{externalTransactionId}`.
- **`payloadHash`** = SHA-256 (hex) do JSON canônico dos campos de negócio: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency` e `referenceExternalTransactionId`. JSON canônico: chaves ordenadas recursivamente, campos `undefined` omitidos, sem espaços. Header, `correlationId` e metadados de transporte não entram, então o mesmo pedido chegando por HTTP e por SQS tem o mesmo hash.
- Mesma chave e mesmo hash: replay com o resultado original (`idempotentReplay: true`), inclusive o saldo observado na época (`resulting_balance`, gravado na própria transação, porque `LOSS` e rejeições não têm lançamento de ledger).
- Mesma chave com hash diferente, ou mesmo `(providerId, externalTransactionId)` com outra chave: `409 IDEMPOTENCY_CONFLICT`, nunca replay.
- Rejeições também são idempotentes: o replay de uma aposta rejeitada por saldo insuficiente continua rejeitado, mesmo que a wallet tenha recebido crédito depois.
- As duas buscas (por chave e por id externo) são **uma única consulta**. Em duas consultas separadas, um commit concorrente entre elas gerava falso conflito; o teste das 50 requisições paralelas encontrou essa race.
- A idempotência é consultada **antes** do lock (replays não esperam na fila da wallet) e de novo **depois** do lock (para quem esperou atrás da transação original).
- Nada disso usa memória: o estado vive no banco e funciona com qualquer número de instâncias.

### Idempotência na fila

Além da chave da transação, o consumidor SQS grava a inbox `(consumerName, messageId)` na mesma transação. Ela distingue "mesma mensagem reentregue" (replay silencioso) de "mensagem nova com a mesma chave" (que passa pela regra acima). Ver [messaging.md](messaging.md).
