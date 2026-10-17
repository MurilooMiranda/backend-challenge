# 11. Testar contra Postgres e SQS reais, sem mocks

Data: 2026-10-15

## Status

Aceito

## Contexto

As garantias centrais do serviço são comportamentos da infraestrutura: `SELECT FOR UPDATE`, `SKIP LOCKED`, constraints e triggers deferidos, ordenação FIFO, visibility timeout, redrive para a DLQ. Um mock dessas peças reproduz a nossa suposição sobre elas, não o comportamento real, e passaria mesmo com o código errado.

## Decisão

- Testes de integração e concorrência usam PostgreSQL 17 e LocalStack (SQS) reais, os mesmos do `docker-compose.yml`.
- Os testes usam um banco separado (`wagering_test`) e criam filas FIFO temporárias por execução, então rodam ao lado do ambiente de desenvolvimento.
- Os cenários de concorrência sobem **três processos da aplicação** e matam um deles no meio da carga.
- Testes de propriedade (fast-check) geram sequências aleatórias de operações, no domínio e contra o banco com concorrência real, com seed reproduzível.
- O CI sobe o mesmo compose para rodar essa suíte.

## Alternativas consideradas

- **Repositórios em memória para os testes de caso de uso.** Rápidos, mas não testam locks, constraints nem transações, que é exatamente onde estão os bugs de concorrência.
- **Testcontainers.** Equivalente em fidelidade; o compose já existia e é o mesmo que o avaliador usa.

## Consequências

- Os testes encontraram bugs reais que mocks não encontrariam: a race entre as duas buscas de idempotência, o `ON CONFLICT` com alvo falhando sob concorrência e o bloqueio de grupo FIFO por mensagens lidas e não apagadas.
- A suíte completa leva cerca de um minuto e exige Docker.
- Unitários e propriedades de domínio continuam rodando sem infraestrutura.
