# Teste de carga

Relatório do experimento executado com `bun run test:load`. O resultado bruto da execução mais recente fica em [results/latest.md](results/latest.md) e [results/latest.json](results/latest.json).

## Objetivo

Medir throughput, latência (p50, p95, p99), taxa de erro, contenção de lock por wallet e atraso da outbox com **três instâncias** da aplicação compartilhando Postgres e SQS, e confirmar que a correção financeira se mantém sob carga: ao final, **toda wallet precisa ter saldo igual ao reconstruído pelo ledger**.

Não havia meta de RPS. O foco foi entender onde o sistema satura e o que limita cada parte.

## Ambiente

Tudo roda na mesma máquina: gerador de carga, três processos da aplicação, Postgres e LocalStack. Os números medem, portanto, um sistema que **disputa a mesma CPU com o próprio cliente**, e não a capacidade de um deploy real.

| Item      | Valor                                                                                                                   |
| --------- | ----------------------------------------------------------------------------------------------------------------------- |
| Máquina   | notebook, Intel Core i7-1355U (10 núcleos / 12 threads), 32 GB de RAM                                                   |
| Sistema   | Windows 11 (build 26200), Docker Desktop 29.8 com backend WSL 2                                                         |
| Runtime   | Bun 1.4.3 (aplicação e gerador)                                                                                         |
| Banco     | PostgreSQL 17.11 (container `postgres:17-alpine`, configuração padrão)                                                  |
| Fila      | LocalStack 4.4 community (SQS FIFO)                                                                                     |
| Aplicação | 3 processos `bun src/main.ts`, cada um com API, consumidor SQS (4 pollers), publisher da outbox e worker de referências |

## Metodologia

1. Cria o banco `wagering_load` (se não existir), aplica as migrations e esvazia as tabelas.
2. Cria filas FIFO temporárias no LocalStack e sobe as 3 instâncias apontando para elas.
3. Abre **204 wallets** com saldo de 1.000.000,00 BRL: 200 normais e **4 "quentes"**, que recebem 20% de todo o tráfego para provocar disputa de lock.
4. **Fase HTTP (30 s):** 48 usuários virtuais em laço fechado (cada um envia a próxima requisição assim que recebe a anterior), distribuídos em round-robin entre as 3 instâncias. Mistura de operações:

   | Operação                                            | Participação |
   | --------------------------------------------------- | ------------ |
   | `BET` (1,00 a 20,00)                                | ~60%         |
   | `WIN` (1,00 a 20,00)                                | ~15%         |
   | `LOSS`                                              | ~10%         |
   | `REFUND` de uma `BET` já processada da mesma rodada | ~5%          |
   | replay idêntico de uma requisição anterior          | 5%           |

5. Durante a fase HTTP, uma amostra por segundo do backlog da outbox (eventos pendentes e idade do mais antigo).
6. Medição do tempo até a outbox zerar após o fim da carga.
7. **Fase SQS:** 2.000 mensagens `BET` enviadas em lote para a fila de entrada, e medição do tempo até todas estarem aplicadas (linhas na inbox).
8. Coleta do `/metrics` das três instâncias (histogramas de processamento e de espera de lock, conflitos, duplicatas, retries, DLQ).
9. **Verificação de correção** com uma única consulta: saldo de cada wallet × soma de créditos e débitos do ledger.

Definições:

- **Latência** é medida no cliente, do envio ao fim da leitura da resposta. Os percentis do servidor vêm dos histogramas do Prometheus, interpolados dentro do bucket.
- **Erro** é qualquer resposta fora de `200`, `201`, `202` e `422`, ou falha de rede/timeout (10 s por requisição). `422` é uma rejeição de negócio válida, não erro.
- **Outbox lag** é a idade do evento pendente mais antigo.

## Resultados

As tabelas desta seção foram medidas **antes** do ledger de partidas dobradas. O custo que ele acrescentou está em [Custo das partidas dobradas](#custo-das-partidas-dobradas), e o `bun run test:load` atual já inclui o razão contábil.

### Configuração padrão (4 execuções)

| Execução | Throughput | p50    | p95    | p99    | Erros | Espera de lock p95 / p99 | Outbox lag máx. | SQS       | Wallets divergentes |
| -------- | ---------- | ------ | ------ | ------ | ----- | ------------------------ | --------------- | --------- | ------------------- |
| 1        | 282 req/s  | 154 ms | 311 ms | 474 ms | 0     | 130 / 314 ms             | 0,45 s          | 156 msg/s | **0**               |
| 2        | 287 req/s  | 152 ms | 292 ms | 436 ms | 0     | 126 / 282 ms             | 0,47 s          | 153 msg/s | **0**               |
| 3        | 237 req/s  | 165 ms | 430 ms | 617 ms | 0     | 156 / 445 ms             | 0,85 s          | 127 msg/s | **0**               |
| 4        | 266 req/s  | 165 ms | 310 ms | 439 ms | 0     | 129 / 281 ms             | 0,74 s          | 97 msg/s  | **0**               |

- Cerca de 8.000 requisições HTTP por execução, sendo 5% replays, todos respondidos como `200` com `idempotentReplay: true`.
- **Nenhum erro** e **nenhuma wallet divergente** nas quatro execuções.
- **Nenhum conflito de concorrência** precisou de retry. Isso é esperado: a mesma chave de idempotência nunca foi enviada para wallets diferentes.
- A outbox **zerou em 0,26 s** após o fim da carga em todas as execuções.
- Nenhuma mensagem foi para a DLQ e nenhuma publicação da outbox falhou.

### Varredura de concorrência (20 s de HTTP, 200 mensagens SQS)

| Usuários virtuais | Throughput    | p50        | p95        | p99        | Espera de lock p95 |
| ----------------- | ------------- | ---------- | ---------- | ---------- | ------------------ |
| 8                 | 238 req/s     | 32 ms      | 55 ms      | 74 ms      | 16 ms              |
| 16                | 254 req/s     | 60 ms      | 111 ms     | 143 ms     | 34 ms              |
| 32                | 286 req/s     | 102 ms     | 209 ms     | 344 ms     | 102 ms             |
| 48                | 237–287 req/s | 152–165 ms | 292–430 ms | 436–617 ms | 126–156 ms         |
| 96                | 260 req/s     | 344 ms     | 537 ms     | 806 ms     | 144 ms             |

### Efeito das wallets quentes (48 usuários, 30 s)

| Tráfego nas 4 wallets quentes | Throughput      | p95          | Espera de lock p95 | Espera de lock p99 |
| ----------------------------- | --------------- | ------------ | ------------------ | ------------------ |
| 20% (padrão)                  | 237–287 req/s   | 292–430 ms   | 126–156 ms         | 281–445 ms         |
| 0% (2 execuções)              | 235 / 256 req/s | 449 / 319 ms | 35 / 44 ms         | 97 / 95 ms         |

## Análise

**O sistema satura em cerca de 250–290 req/s nesta máquina, a partir de 16–32 usuários.** Acima disso, o throughput não sobe e a latência cresce em proporção à concorrência: com 48 usuários e cerca de 270 req/s, a Lei de Little prevê 48 / 270 ≈ 178 ms por requisição, próximo do observado. É fila, não degradação. O recurso esgotado é a CPU compartilhada entre cliente, três processos Bun, Postgres e LocalStack. Os números absolutos, portanto, subestimam a capacidade de um deploy com máquinas separadas. A forma da curva e os gargalos encontrados são o resultado útil.

**O lock por wallet faz exatamente o que se espera.** Com 20% do tráfego em 4 wallets, a espera p95 pelo lock fica em 126–156 ms. Sem wallets quentes, cai para 35–44 ms, e o p99 cai de cerca de 300 ms para cerca de 95 ms. Wallets diferentes não disputam lock entre si, então a contenção aparece só onde há concentração real de operações, e não piora o throughput global. Esse é o custo conhecido da serialização por linha, registrado como limitação da estratégia escolhida.

**A variação entre execuções é grande** (237 a 287 req/s, p99 de 436 a 617 ms). Ela vem de ruído do ambiente: processos do Windows, Docker sobre WSL 2 e um único LocalStack servindo três instâncias. Por isso a configuração padrão foi repetida quatro vezes e o relatório mostra faixas, não médias. A comparação com e sem wallets quentes só é conclusiva para a espera de lock, cuja diferença (3x) é muito maior que o ruído. Para o throughput, não é.

## Gargalos encontrados e corrigidos

A primeira execução expôs um problema real: **a outbox não acompanhava a carga.** Cada passo abaixo foi medido na configuração padrão.

| Versão                                                  | Outbox: pendentes máx. | Lag máx. | Zerar após a carga | SQS       | HTTP                  |
| ------------------------------------------------------- | ---------------------- | -------- | ------------------ | --------- | --------------------- |
| Linha de base: 1 evento por vez, 1 por wallet por ciclo | 9.852                  | 27,2 s   | 33,2 s             | 92 msg/s  | 262 req/s, p95 307 ms |
| Publicação paralela entre wallets, lote de 100          | 8.719                  | 28,4 s   | 29,1 s             | 89 msg/s  | 273 req/s             |
| Até 20 eventos por wallet por ciclo                     | 7.754                  | 26,7 s   | 13,5 s             | 87 msg/s  | 242 req/s, p95 592 ms |
| `SendMessageBatch` (10 eventos por chamada)             | 225                    | 0,49 s   | 0,26 s             | 101 msg/s | 291 req/s, p95 299 ms |
| 4 pollers SQS por instância                             | 205                    | 0,47 s   | 0,26 s             | 162 msg/s | 302 req/s             |

1. **Publicação um a um.** Cada envio ao SQS custava cerca de 13 ms, e cada instância publicava um evento por vez, enquanto a carga gerava uns 500 eventos/s. Publicar em paralelo quase não mudou nada, o que mostrou que o gargalo estava em outro lugar.
2. **Ordem por wallet limitando a vazão.** A garantia de ordem por wallet deixava sair só o evento mais antigo de cada wallet por ciclo. As wallets quentes, com cerca de 28 eventos/s cada, ficavam para trás indefinidamente. A solução preserva a garantia: o publisher reivindica a wallet travando o evento mais antigo dela (`FOR UPDATE SKIP LOCKED`) e, na mesma transação, leva os próximos até 20 eventos daquela wallet, em ordem. Nenhum outro publisher consegue pegá-los enquanto o primeiro estiver travado. Os testes `competing publishers keep per-wallet order...` e `a partially failed batch republishes...` cobrem esse comportamento.
3. **Teto de envios do SQS.** Um micro-benchmark direto no LocalStack mostrou cerca de 545 envios avulsos/s contra cerca de 4.000/s em `SendMessageBatch`. Com a publicação em lote (o FIFO preserva a ordem por grupo dentro do lote), o lag caiu de **27 s para menos de 1 s**. Se uma entrada do lote falha, os eventos seguintes da mesma wallet ficam pendentes e saem depois dela.
4. **Consumo SQS.** Cada instância tinha um único loop de long polling, com no máximo 10 mensagens em processamento. Com 4 loops por instância (seguro porque o FIFO nunca entrega o mesmo grupo a dois consumidores ao mesmo tempo), o consumo subiu de cerca de 100 para cerca de 160 msg/s.

## Custo das partidas dobradas

Com o razão contábil, cada transação que move saldo passa a gravar também um lançamento contábil e dois postings, garantir que as contas existem e executar três verificações deferidas no COMMIT (lançamento balanceado e vínculo nos dois sentidos entre o ledger da wallet e o razão). Configuração padrão:

| Versão                                                           | Execuções | Throughput    | p50        | p95        | p99        | Espera de lock p95 / p99 |
| ---------------------------------------------------------------- | --------- | ------------- | ---------- | ---------- | ---------- | ------------------------ |
| Sem partidas dobradas                                            | 4         | 237–287 req/s | 152–165 ms | 292–430 ms | 436–617 ms | 126–156 / 281–445 ms     |
| Partidas dobradas, contas garantidas dentro da seção crítica     | 2         | 188–213 req/s | 197–215 ms | 457–524 ms | 727–772 ms | 208–215 / 486–550 ms     |
| Partidas dobradas, contas garantidas **antes** do lock da wallet | 3         | 182–202 req/s | 216–242 ms | 426–471 ms | 648–786 ms | 166–178 / 436–503 ms     |

Em todas as 5 execuções com o razão contábil: **0 erros, 0 wallets divergentes, 0 lançamentos contábeis desbalanceados e 0 wallets com saldo diferente da conta contábil do jogador**. Débitos e créditos totais do razão fecharam nos centavos (por exemplo, 204.052.439,11 / 204.052.439,11).

Leitura dos números:

- O razão contábil custa **cerca de 25–30% do throughput** nesta máquina. O custo é trabalho de banco por transação (mais statements e mais verificações no COMMIT) numa CPU já saturada.
- Mover o upsert das contas para **antes** de travar a wallet encurtou a seção crítica: a espera p95 pelo lock caiu de cerca de 210 ms para cerca de 170 ms. O throughput não mudou, o que confirma que o limite é o trabalho total, e não a disputa pelo lock.
- As contas da casa **não têm saldo materializado**. Se tivessem, toda aposta de um provedor precisaria travar a mesma linha: um lock global, que transformaria o provedor inteiro em uma wallet quente. O saldo delas é calculado no balancete.

## Anomalia observada

Em uma execução da varredura (32 usuários), uma requisição ficou sem resposta por cerca de 290 s, até o timeout padrão do `fetch` do Bun, e a execução seguinte não conseguiu subir as instâncias no tempo limite. Depois disso, o gerador passou a usar timeout de 10 s por requisição (contado como erro), a gravar o log de cada instância em `results/instance-N.log` e a salvar um snapshot de `pg_stat_activity` no primeiro timeout. **Nas 9 execuções seguintes o problema não se repetiu**, então a causa não foi identificada. A instrumentação ficou no gerador para capturar o estado do banco se voltar a acontecer.

## Limitações do experimento

- Cliente e servidores na mesma máquina: o gerador compete por CPU com o que está sendo medido.
- LocalStack não reproduz latência nem limites da AWS. O teto de cerca de 545 envios avulsos/s é do LocalStack, não do SQS real.
- Postgres com configuração padrão, sem ajuste de `shared_buffers`, `max_connections` ou pool.
- Execuções de 20–30 s medem regime estável curto. Não houve teste de longa duração (vazamento de memória, crescimento de inbox e outbox).
- O gerador é de laço fechado: mede throughput máximo sustentável, não latência sob uma taxa de chegada fixa (laço aberto).
- Saldos iniciais altos fazem quase nenhuma `BET` ser rejeitada; o caminho de rejeição é coberto pelos testes de concorrência, não por este experimento.

## Como reproduzir

```bash
docker compose up -d
bun run test:load
```

Parâmetros por variável de ambiente (`LOAD_CONCURRENCY`, `LOAD_DURATION_SECONDS`, `LOAD_HOT_SHARE`, ...) estão descritos no [README](../README.md#teste-de-carga). Exemplos usados neste relatório:

```bash
LOAD_CONCURRENCY=16 LOAD_DURATION_SECONDS=20 LOAD_SQS_MESSAGES=200 bun run test:load
LOAD_HOT_SHARE=0 bun run test:load
```
