# 2. Ports and adapters com domínio puro

Data: 2026-10-14

## Status

Aceito

## Contexto

As regras financeiras (saldo, reversões, estados da transação) são a parte mais crítica e a que mais precisa de teste exaustivo. A mesma regra é acionada por três entradas (HTTP, SQS e o worker de referências pendentes) e precisa se comportar igual em todas. Frameworks (NestJS), ORM (MikroORM) e runtime (Bun) são escolhas que podem mudar.

## Decisão

Organizar o código em quatro camadas, com dependências apontando só para dentro:

| Camada           | Depende de | Conteúdo                                                                                   |
| ---------------- | ---------- | ------------------------------------------------------------------------------------------ |
| `domain`         | nada       | entidades, value objects, domain services e eventos                                        |
| `application`    | `domain`   | casos de uso e ports (interfaces) para persistência, mensageria, relógio, ids e telemetria |
| `infrastructure` | todas      | adapters: MikroORM, SQS, Prometheus, OpenTelemetry, JWT                                    |
| `interfaces`     | todas      | controllers HTTP, consumidor SQS, ciclo de vida dos workers                                |

- O domínio não importa Nest, ORM nem Bun. Entidades têm construtor privado; `create`/`open`/`from` validam e `rehydrate` só reconstrói estado persistido.
- Relógio e gerador de ids são injetados, então o domínio é determinístico.
- HTTP e SQS chamam **o mesmo caso de uso** (`ProcessWagerTransaction`), e o worker de referências pendentes reaplica a mesma regra de domínio pelo mesmo caminho de gravação (`settleAndStage`). A diferença entre as entradas fica restrita à tradução de entrada e saída.
- A ligação entre ports e adapters é feita em um único lugar, `src/app.module.ts`.

## Alternativas consideradas

- **Lógica nos services do Nest com entidades do ORM.** Menos código, mas cada teste de regra de negócio exigiria banco ou mocks do ORM, e o ORM vazaria para as regras.
- **Uma implementação por canal.** Duplicaria a regra financeira, com risco de HTTP e SQS divergirem.

## Consequências

- O domínio tem testes unitários rápidos e testes de propriedade sem I/O.
- Há mais código de mapeamento (records ↔ entidades, `mappers.ts`) e mais interfaces.
- Trocar o ORM, o broker ou o framework HTTP afeta só `infrastructure` e `interfaces`.
