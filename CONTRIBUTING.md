# Contributing to VEYRA

## Before you start

1. Read [README.md](README.md), [AGENTS.md](AGENTS.md) and the docs for the area you are
   changing (start with [ARCHITECTURE](docs/architecture/ARCHITECTURE.md) and
   [ACCESS_CONTROL](docs/security/ACCESS_CONTROL.md)).
2. Set up your machine: [DEVELOPMENT_SETUP](docs/engineering/DEVELOPMENT_SETUP.md). The
   checkout must be on an NTFS (not exFAT) drive.

## Workflow

1. Branch from `main`: `feat/<ticket>-short-description`, `fix/<ticket>-short-description` or
   `chore/<short-description>`.
2. Make one focused change: domain + persistence + API + UI + tests + docs for one slice.
3. Run everything locally:

   ```powershell
   bun run lint
   bun run typecheck
   bun run test
   bun run build
   ```

4. Open a pull request using the template. CI must pass and a reviewer must approve.
   Finance, identity, permission and tenant-isolation changes need a second approval.

## Commit messages

Imperative, present tense, short subject line: `Add visitor pass expiry check`. Reference the
issue in the body when there is one.

## Non-negotiables

- Every protected endpoint checks permissions on the server and respects tenant boundaries.
- Money uses `Money` (bigint minor units + currency). Never floats.
- No secrets, real personal data or production data in code, tests or fixtures.
- No placeholder or fake responses in production code paths.
- Never disable lint or type checks to get a green build.
- Database changes go through reviewed migrations; destructive changes use expand-and-contract.

Full standards: [ENGINEERING_STANDARDS](docs/engineering/ENGINEERING_STANDARDS.md).

## Security issues

Do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
