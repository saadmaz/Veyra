# VEYRA API (`@veyra/api`)

NestJS REST API at `/api/v1`. All business rules, authorisation and tenant isolation live here.

```powershell
bun run --cwd apps/api dev
```

- Liveness: http://localhost:4000/api/v1/health/live
- Readiness: http://localhost:4000/api/v1/health/ready (503 until Postgres and Redis are up)
- OpenAPI UI: http://localhost:4000/api/docs (not in production)

`src/platform/` holds cross-cutting code; business modules go in `src/modules/<module>/` with
`domain / application / infrastructure / presentation` layers (docs/architecture/ARCHITECTURE.md).
