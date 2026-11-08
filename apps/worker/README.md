# VEYRA Worker (`@veyra/worker`)

Background job process (BullMQ on Redis): notifications, billing runs, reconciliation, exports,
reminders. Same codebase as the API, run as a separate process so each scales independently.

```powershell
bun run --cwd apps/worker dev   # health on http://localhost:4001/health/ready
```

Every job carries a `JobEnvelope`. `JobRouter` rejects tenant jobs without tenant context;
tenant-less jobs must be declared as platform jobs. Register handlers in `src/jobs.ts`.
