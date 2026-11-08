# Codex — First Task (Phase 0: Repository Audit and Discovery)

Paste the following into Codex:

---

Read `AGENTS.md` and everything under `docs/` in full before doing anything else.

Execute **Phase 0 — Repository audit and discovery** only. Do not write application code.

1. Audit the repository: list what exists, what is missing, and any conflicts with
   `AGENTS.md`.
2. Fill in these documents with concrete, VEYRA-specific content (replace the stubs):
   - `docs/architecture/ARCHITECTURE.md` — modular monolith layout, module boundaries,
     API vs worker processes, data flow.
   - `docs/architecture/MULTI_TENANCY.md` — tenant hierarchy, isolation strategy
     (row-level tenant keys and/or PostgreSQL RLS — recommend one with trade-offs),
     tenant context propagation through HTTP, jobs and events.
   - `docs/security/ACCESS_CONTROL.md` — RBAC + resource-scope model, permission
     matrix for the roles in AGENTS.md section 6, membership validity periods.
   - `docs/architecture/DATA_MODEL.md` — core entities for Phases 2–4 (Organisation,
     Property, Building, Floor, Unit, User, Membership, Role, Ownership, Tenancy,
     Household) and the ledger approach for Phase 6.
   - `docs/engineering/REPOSITORY_STRUCTURE.md` — proposed Bun + Turborepo layout
     (apps/web, apps/api, apps/worker, apps/mobile, packages/*).
   - `docs/adr/0001-modular-monolith.md` and `docs/adr/0002-multi-tenancy.md`.
3. Produce a Phase 1 plan with acceptance criteria, the exact tooling to set up, and
   the tests that will prove the foundation works.
4. List open questions and decisions that need my input.

Do not commit or push. Do not add co-author or AI attribution lines anywhere.
Stop after Phase 0 and wait for my review.