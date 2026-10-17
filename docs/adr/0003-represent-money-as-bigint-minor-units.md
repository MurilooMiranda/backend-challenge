# 3. Representar dinheiro como bigint em centavos

Data: 2026-10-14

## Status

Aceito

## Contexto

`number` em JavaScript é ponto flutuante binário: `0.1 + 0.2 !== 0.3`, e inteiros acima de 2^53 perdem precisão. Num serviço financeiro, qualquer arredondamento silencioso é um bug. O desafio usa valores com duas casas decimais e só precisa de soma, subtração e comparação (não há juros, câmbio nem divisão).

## Decisão

- `Money` guarda o valor em **centavos como `bigint`**, com escala fixa de 2 casas, mais o código da moeda.
- A entrada é sempre string no formato `^(0|[1-9]\d*)\.\d{2}$`; números JSON e formatos alternativos são rejeitados.
- A saída é sempre `toJSON()`, que produz a string decimal. `JSON.stringify` de um `bigint` lança erro, então o valor interno não vaza por acidente.
- No banco, `NUMERIC(20,2)`; o driver devolve string, reidratada com `Money.from`. O valor nunca passa por `number`.
- Operações entre moedas diferentes lançam erro.

## Alternativas consideradas

- **`number` com arredondamento.** Rejeitado: perda de precisão silenciosa.
- **Biblioteca decimal (decimal.js, big.js).** Correta e flexível, mas resolve escalas variáveis e divisão, que o desafio não exige, ao custo de uma dependência e de uma política de arredondamento a configurar.
- **Aceitar `number` na entrada e converter.** Rejeitado: `25.1` e `25.10` viram o mesmo valor, mas o cliente pode ter mandado `25.099999999`; além disso, formatos ambíguos tornariam o hash de idempotência instável.

## Consequências

- Aritmética exata e trivialmente testável, inclusive acima de `Number.MAX_SAFE_INTEGER`.
- Suportar moedas com 0 ou 3 casas decimais exigiria tornar a escala parte da moeda.
- Clientes precisam enviar valores como string, o que está documentado no contrato da API.
