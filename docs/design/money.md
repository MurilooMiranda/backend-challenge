# Dinheiro

> Decisão registrada em [ADR 0003](../adr/0003-represent-money-as-bigint-minor-units.md).

`Money` (`src/domain/money/money.ts`) guarda o valor em **centavos como `bigint`**, mais o código da moeda.

## Representação

- A escala é fixa em 2 casas e entradas com mais casas são rejeitadas. Com isso só existem soma, subtração e comparação, operações que em inteiros são exatas. Uma biblioteca decimal resolveria escalas variáveis, que o desafio não exige, ao custo de uma dependência e de uma política de arredondamento a configurar.
- `bigint` não tem o limite de 2^53 do `number`; os testes cobrem valores acima de `Number.MAX_SAFE_INTEGER`.
- `JSON.stringify` lança erro com `bigint`, então o valor interno não vaza por acidente. A única saída é `toJSON()`, que produz a string decimal do contrato (`{ "amount": "25.00", "currency": "BRL" }`).
- `Money` pode ser negativo internamente (`subtract`, `negate`), por exemplo numa diferença de reconciliação. Quem proíbe saldo negativo são a `Wallet` e o banco.
- Operações entre moedas diferentes lançam `CurrencyMismatchError`. O modelo é multi-moeda: uma wallet por `playerId` + `currency`.

## Entrada

Aceito: `amount` como string que casa com `^(0|[1-9]\d*)\.\d{2}$` e `currency` com `^[A-Z]{3}$`.

Rejeitado com `400`: números JSON e qualquer tipo que não seja string (`INVALID_PAYLOAD`, na validação do schema); `NaN`, `Infinity`, notação científica, string vazia, sinal, zeros à esquerda, vírgula, uma ou três casas decimais e moeda fora do padrão (`INVALID_MONEY`, no domínio). Aceitar `number` levaria a perda de precisão silenciosa em `0.1 + 0.2`, e aceitar formatos alternativos tornaria o hash de idempotência ambíguo (`"25.0"` e `"25.00"` seriam o mesmo valor com hashes diferentes).

## Persistência

`NUMERIC(20,2)`, com a moeda em coluna separada. O driver do Postgres devolve `NUMERIC` como string (`"75.50"`), reidratada com `Money.from`; o valor nunca passa por `number` em nenhum ponto do caminho. As agregações em SQL (reconciliação, balancete) somam em `NUMERIC` e voltam como string.
