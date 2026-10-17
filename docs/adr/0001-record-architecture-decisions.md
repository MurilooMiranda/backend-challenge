# 1. Registrar decisões de arquitetura

Data: 2026-10-14

## Status

Aceito

## Contexto

O serviço lida com dinheiro, concorrência entre instâncias e mensageria at-least-once. Várias escolhas não são óbvias pelo código (por que lock pessimista e não otimista, por que triggers no banco, por que a reconciliação não corrige nada), e a pergunta "por que isso é assim?" vai aparecer em revisões, na apresentação e para quem mantiver o código depois.

## Decisão

Registrar cada decisão arquiteturalmente significativa como um Architecture Decision Record, no formato descrito por Michael Nygard em [Documenting Architecture Decisions](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions):

- um arquivo por decisão em `docs/adr/`, numerado em sequência e nomeado como no [adr-tools](https://github.com/npryce/adr-tools): `NNNN-titulo-em-kebab-case.md`;
- seções **Status**, **Contexto**, **Decisão** e **Consequências**, mais **Alternativas consideradas** quando houver;
- status `Proposto`, `Aceito`, `Rejeitado`, `Obsoleto` ou `Substituído por [ADR NNNN]`;
- uma ADR aceita não é reescrita para mudar a decisão: uma nova ADR a substitui e as duas passam a apontar uma para a outra.

As ADRs explicam o **porquê**. O **como** fica nos documentos de `docs/design/`, que podem mudar livremente junto com o código.

## Consequências

- A justificativa de cada decisão fica versionada junto com o código e revisável em pull request.
- O custo é escrever um documento curto por decisão relevante. Decisões pequenas ou facilmente reversíveis não precisam de ADR.
- Decisões tomadas antes desta ADR foram registradas retroativamente, com a data do commit que as introduziu.
