# ADR 0001: Modular monolith

- **Status:** Accepted
- **Date:** 2026-11-08

## Context

VEYRA has 20 product capability areas, a small initial team and a cost-conscious hosting
budget. Microservices would add network failure modes, distributed transactions, per-service
deployment pipelines and observability overhead before there is any proven need. A plain
monolith, on the other hand, tends to decay into tangled code that cannot be split later.

## Decision

Build the backend as a **modular monolith** in NestJS:

- One codebase, two process types: `api` (HTTP) and `worker` (BullMQ jobs), scaled independently.
- Business modules with layered internals (domain / application / infrastructure / presentation).
- Modules interact only through exported application interfaces and domain events
  (transactional outbox).
- One PostgreSQL database; each module owns its tables and no module writes another's tables.

## Consequences

- Positive: single deploy, simple local development, ACID transactions within a request,
  low infrastructure cost, refactoring across modules is cheap.
- Negative: one bad deploy affects every module; module discipline must be enforced by
  review and tooling rather than network boundaries.
- Extraction of a module into a service remains possible when a concrete need arises
  (see [ARCHITECTURE](../architecture/ARCHITECTURE.md#9-extraction-path)).

## Revisit when

- A module has materially different scaling requirements.
- A team needs independent ownership and release cadence.
- Fault isolation requirements justify separation.
- A provider or device integration needs a distinct runtime boundary.
- Operational evidence shows the monolith is a bottleneck.

Any extraction requires a new ADR with a data ownership plan, API contract, migration strategy,
observability plan and rollback approach.
