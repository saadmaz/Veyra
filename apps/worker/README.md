# VEYRA Worker (`@veyra/worker`)

Background job process (BullMQ on Redis): notifications, billing runs, reconciliation, exports,
reminders. Same codebase as the API, run as a separate process so each scales independently.

```powershell
bun run --cwd apps/worker dev   # health on http://localhost:4001/health/ready
```

Every job carries a `JobEnvelope`. `JobRouter` rejects tenant jobs without tenant context;
tenant-less jobs must be declared as platform jobs. Register handlers in `src/jobs.ts`.

The worker also relays the transactional outbox (ARCHITECTURE section 5): every `OUTBOX_POLL_MS`
(default 15 s) it turns due events into jobs on the `system` queue, at least once, with the outbox
id as job id. Map event types to jobs in `OUTBOX_ROUTES`. It needs `DATABASE_URL` (the restricted
`veyra_app` role) and `REDIS_URL`.

| Outbox event | Job | Does |
| ------------ | --- | ---- |
| `maintenance.sla.due` | `maintenance.sla.check` | Records a missed response or resolution target (Phase 7) |
