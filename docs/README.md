# Documentação

Ponto de entrada da documentação técnica do Distributed Wagering Processor. Para subir o ambiente e rodar os testes, veja o [README](../README.md); para o mapa do sistema, a [ARCHITECTURE.md](../ARCHITECTURE.md).

## Como esta pasta está organizada

| Pasta                    | O que contém                                                                                       | Quando ler                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [`api/`](api/)           | contrato público: especificação OpenAPI (HTTP) e contrato das filas e eventos (SQS)                | integrar um provedor ou um consumidor de eventos                |
| [`design/`](design/)     | documentos de design por assunto: como cada parte funciona e por quê                               | entender ou alterar uma parte do sistema                        |
| [`adr/`](adr/)           | Architecture Decision Records: uma decisão por arquivo, com contexto, alternativas e consequências | entender por que algo é como é, antes de propor mudar           |
| [`runbooks/`](runbooks/) | o que fazer quando um alerta dispara                                                               | durante um incidente (cada alerta do Prometheus aponta para cá) |

## API

- **HTTP:** com a aplicação rodando, a especificação navegável fica em [`/docs`](http://localhost:3000/docs) (Swagger UI) e o documento em `/docs/openapi.json`. A fonte é [`api/openapi.yaml`](api/openapi.yaml), e um teste de contrato falha se uma rota existir no código e não na especificação (ou vice-versa).
- **Mensageria:** [`api/messaging.md`](api/messaging.md) descreve a mensagem de entrada, os eventos de integração publicados, a ordenação e a semântica de entrega.

## Design

| Documento                                                               | Assunto                                                                                    |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [money.md](design/money.md)                                             | representação de dinheiro, validação de entrada e persistência                             |
| [persistence.md](design/persistence.md)                                 | ORM, migrations e as invariantes garantidas pelo banco, incluindo partidas dobradas        |
| [concurrency-and-idempotency.md](design/concurrency-and-idempotency.md) | lock por wallet, conflitos entre instâncias, chave de idempotência e hash do payload       |
| [business-rules.md](design/business-rules.md)                           | máquina de estados, regras por tipo de transação, `failureCode`, referências fora de ordem |
| [messaging.md](design/messaging.md)                                     | consumidor SQS, inbox, DLQ, transactional outbox e retenção                                |
| [observability.md](design/observability.md)                             | logs, métricas, traces, reconciliação, alertas e health checks                             |
| [security.md](design/security.md)                                       | autenticação OIDC com Keycloak e autorização por papel e provedor                          |
| [testing.md](design/testing.md)                                         | estratégia de testes, cenários exigidos e CI                                               |

## Decisões de arquitetura

O índice está em [adr/README.md](adr/README.md). As ADRs seguem o formato de Michael Nygard, com os nomes de arquivo do [adr-tools](https://github.com/npryce/adr-tools) (`NNNN-titulo-em-kebab-case.md`). Uma ADR aceita não é editada para mudar a decisão: uma nova ADR a substitui, e a antiga passa a ter o status `Substituído por`.
