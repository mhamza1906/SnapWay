# Pipeline cloud storage: Tiger Data and Cloudflare R2

Branch `feature/pipeline-tigerdata` (from `feature/map-authoring-pipeline`). Arjun asked
on 2026-10-17 for the pipeline to use the team's Tiger Data PostgreSQL service and the R2
bucket. Both are **optional**: without their settings the pipeline behaves exactly as
before (local files only), and a storage failure never breaks a pipeline request.

Code: [`apps/pipeline/server/cloud-store.js`](../../apps/pipeline/server/cloud-store.js),
used by [`building-library.js`](../../apps/pipeline/server/building-library.js) and
[`index.js`](../../apps/pipeline/server/index.js). Tests:
[`tests/cloud-store.test.js`](../../apps/pipeline/tests/cloud-store.test.js) (offline, with
in-memory stand-ins).

## What is stored where

| Data                                                     | Where                                          | When                                          |
| -------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------- |
| Buildings (full JSON + list summary)                     | Tiger Data, table `snapway_pipeline.buildings` | `POST /api/buildings/cloud` (explicit save)   |
| Original uploaded plans (PDF/PNG/JPEG)                   | R2 bucket, key `plans/<sha256>.<ext>`          | Every `POST /api/plans` when R2 is configured |
| Everything else (jobs, extractions, caches, editor save) | Local `.local/` and `output/` as before        | Unchanged                                     |

The table lives in its **own schema**, `snapway_pipeline`, created on the first save
(`CREATE SCHEMA/TABLE IF NOT EXISTS`). It never touches the Django API's tables. Rows are
keyed by `building.id`, so saving the same building again updates it. Columns: `id`,
`name`, `building` (jsonb), `summary` (jsonb), `sha256`, `size_bytes`, `created_at`,
`updated_at`. R2 objects are content-addressed, so the same file is stored once.

## Settings

In `apps/pipeline/.env.prod` (team) or `.env.dev` (Arjun); never in Git:

| Variable                                                                      | Meaning                                                                         |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                | `postgres://USER@HOST:PORT/tsdb?sslmode=require`                                |
| `PGPASSWORD`                                                                  | The database password, if it is not in `DATABASE_URL` (`~/.pgpass` also works)  |
| `PGSSLMODE`, `PGSSLROOTCERT`                                                  | Optional; used when the URL has no `sslmode`                                    |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` | R2 S3-compatible access (endpoint `https://<account>.r2.cloudflarestorage.com`) |

TLS follows libpq: `require` encrypts without verifying the server certificate (the
Free-plan demo exception already approved in [deployment.md](../deployment.md));
`verify-full`/`verify-ca` verify (with `PGSSLROOTCERT` if set). `disable`/`allow`/`prefer`
are refused for a remote host. The pool holds at most 3 connections.

## Endpoints

| Method and path                 | Request                  | Response                                                                                                                                                                                  |
| ------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/storage/check`        | (none)                   | `{database: {configured, ok, schema, tableCreated, buildings} \| {configured, ok: false, error}, r2: {configured, ok, bucket} \| {…, error}}`. Connects for real and **changes nothing**. |
| `POST /api/buildings/cloud`     | The building as the body | `{key: "cloud-<id>", sha256, updated, updatedAt}`; `400` schema failure, `503` not configured, `502` database error                                                                       |
| `GET /api/buildings`            |                          | Also lists Tiger Data rows (`source: "cloud"`, label "Tiger Data") from the stored summary. An unreachable database is skipped for 60 s; local files are always listed.                   |
| `GET /api/buildings/cloud-<id>` |                          | The full building from Tiger Data                                                                                                                                                         |
| `POST /api/plans`               | (unchanged)              | Adds `storage: {key, sha256, uploaded}` when R2 is configured, or `storage: {error}` if the copy failed (the plan is still prepared)                                                      |

Errors returned to clients or logged never contain connection strings or keys.

## Live check (2026-10-17, read-only)

With the settings Arjun supplied: **R2 ok** (bucket `htv-indoor-navigation` reachable).
**Tiger Data reachable over TLS, login not done**: `DATABASE_URL` has no password, so
the server stopped at authentication. Add `PGPASSWORD` locally, then
`curl -s http://127.0.0.1:5175/api/storage/check`. No table has been created and nothing
has been written to either service.

## Open points for the team

- **Which database.** `tsdbadmin` is the service owner role. If this is the same Tiger
  service the Django API uses in production, prefer a dedicated `snapway_pipeline` role
  with rights on that schema only ([deployment.md](../deployment.md) asks for dedicated
  runtime roles).
- **Long term**, buildings should flow into the Django `maps` models through the API
  rather than a separate table; this schema is a staging store for authoring output.
- R2 objects are private; there is no public URL or listing endpoint yet.
- New dependencies: `pg` and `@aws-sdk/client-s3` (requested by Arjun for this feature).
