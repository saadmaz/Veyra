# ADR 0007: S3-compatible object storage with signed, checked uploads

- **Status:** Accepted
- **Date:** 2026-11-12

## Context

Phase 7 needs photos on maintenance requests and work orders (owner decision, 2026-11-11), and
later phases need documents. ARCHITECTURE already names S3-compatible object storage for file
bytes with metadata in PostgreSQL. Open questions were how files reach storage, which client
library signs requests, what runs locally, and how to stop a file from being something other
than it claims.

## Decision

- **Port and adapter.** `platform/storage/object-storage.ts` defines a small port (presign
  upload, presign download, stat, read the first bytes, remove). `S3ObjectStorage` implements it
  for any S3-compatible service: AWS S3, Cloudflare R2 (the stack's cloud provider), or a
  self-hosted server. Without `STORAGE_BUCKET` the port is absent and file routes answer 409
  `STORAGE_NOT_CONFIGURED`; nothing else depends on storage.
- **Library.** `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`, API workspace only.
  Request signing (SigV4) is security-sensitive, and these are the maintained reference
  implementation that also works with R2 and self-hosted servers. Hand-written signing was
  rejected.
- **Bytes never pass through the API.** The API records a PENDING attachment and returns a PUT
  URL valid for 10 minutes, signed with the content type and the exact length, so storage refuses
  any other upload. The browser uploads directly, then calls `complete`. The API checks the
  stored size and reads the first 32 bytes to confirm the real type (JPEG, PNG, WebP, HEIC or PDF
  by magic number). Anything else is deleted and the attachment is REJECTED. Downloads are GET
  URLs valid for 5 minutes, with the stored type and a safe `Content-Disposition` (inline for
  photos, attachment for PDFs).
- **Keys** are chosen by the server, `org/<organisation>/prop/<property>/maintenance/<id>`
  (checked by the database), and never contain the file name.
- **Local and CI storage: SeaweedFS** (Apache-2.0, `chrislusf/seaweedfs:4.48`), with signature
  checking on through `infra/seaweedfs/s3.json` (development credentials only). MinIO was the
  first choice, but its community container images are no longer published, so it cannot be
  pulled. CI starts SeaweedFS with `infra/seaweedfs/start-ci.sh` for the adapter's contract test.
  API tests use an in-memory fake.

## Consequences

- One more dependency tree in the API (the AWS SDK v3 S3 client).
- Browsers must reach the storage endpoint, and production buckets need CORS for the console's
  origin (PUT with `Content-Type`, GET). R2 and S3 bucket CORS is part of deployment.
- Uploads that are never completed leave PENDING rows and maybe objects: a worker job and a
  bucket lifecycle rule are needed (technical debt). Objects of removed attachments are deleted
  after the database commit; a failed delete leaves an orphan, never a lost record.
- No malware scanning yet (THREAT_MODEL T7): only photos and PDFs are accepted, types are
  checked by content, and storage serves them from its own origin, not the console's. Add
  scanning before documents (Phase 10) or before a pilot with real residents.
