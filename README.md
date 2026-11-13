# DeployDeck

Single-host PaaS foundation using Next.js App Router, TypeScript, PostgreSQL, Prisma, Docker Engine, and Caddy.

## Current scope

Phases 1 through 3 provide the foundation, authentication, project APIs, a durable deployment queue, pinned Git checkout, and real Docker image builds with persisted redacted logs. Container startup, health checks, deployment routing, rollback, and SSE are not implemented yet. Successful builds stop at `starting`; this does not mean the app is live.

## Start locally

Install Docker Engine with Compose v2, or Docker Desktop using Linux containers. From the repository root:

```sh
npm run setup
docker compose up --build
```

Run the setup once with Node.js 22.12 or newer to generate independent local session and encryption keys in an ignored `.env` file. Existing configuration is never overwritten. Open http://localhost:3000 or http://localhost:8080. PostgreSQL becomes healthy first, the web process applies migrations and starts, and the worker starts after web and proxy readiness. The worker verifies database connectivity, performs a real Docker Engine ping, and reads Caddy configuration through its Unix admin socket.

```sh
docker compose ps
docker compose logs worker
curl --fail http://localhost:3000/api/health
docker compose exec caddy caddy validate --config /etc/caddy/caddy.json
```

Use `docker compose down` to stop. The database persists in a named volume. `docker compose down -v` deletes that data.

## Architecture and process boundaries

- `apps/web`: control plane and UI. No Docker socket or Caddy admin socket is mounted here.
- `apps/worker`: standalone daemon. It alone receives the Docker socket and the client mount of Caddy's admin socket. It polls PostgreSQL for build jobs and is the only process that builds Docker images.
- `packages/db`: shared Prisma client, schema, and versioned SQL migrations.
- `infra/caddy`: proxy configuration with a dedicated dynamic route insertion point (`project-routes`). Unknown project hosts return 404.

Caddy admin listens only on a Unix socket, never on a TCP port. Sharing the public ingress network with web therefore does not expose its admin API. PostgreSQL uses a private internal network and has no published port. Only localhost can reach the UI and proxy ports by default.

The worker is a trusted host administrator because it holds the Docker socket. It runs as root for portable socket access in this local setup. The web process runs as an unprivileged user. This is a local development setup. Before public hosting, configure HTTPS, production database credentials, and a shared login rate limiter.

## Networking for the deployment pipeline

The planned stable app URL is `http://project-<uuid>.localhost:8080`. `BASE_DOMAIN` and `PUBLIC_PORT` are configurable. The future worker must create the host match for that domain after a passing health check.

Inside the Caddy container, `localhost` refers to Caddy itself. Future upstreams must therefore use `host.docker.internal:<allocated-host-port>`, not `localhost:<port>`. Both worker and Caddy have the Linux host-gateway mapping. Published deployment ports must be reachable through that gateway; binding them only to host loopback will not work on Linux. Per-project networks, port allocation, resource limits, health checks, and firewall restrictions arrive with the real container pipeline.

## Database guarantees

Six application tables: users, projects, environment_variables, deployments, deployment_logs, deployment_jobs. Prisma adds its migration bookkeeping table.

The SQL migration supplements Prisma with CHECK constraints and a partial unique index limiting each project to one queued, cloning, building, or starting deployment. It also supplies a pending-job index. Deployment enqueue uses a transaction and a project-row lock; the worker claims pending jobs using `FOR UPDATE SKIP LOCKED` in a transaction that also changes queued to cloning.

`deployments.created_at` is included because deployment history requires its descending index. Log IDs are bigint and must be serialized as strings in future JSON/SSE endpoints. Environment values use AES-256-GCM authenticated encryption.

## Development and verification

Node.js 22.12 or newer is required. Prisma 7.10.1 is pinned; its datasource URL lives in `prisma.config.ts` and the client uses the PostgreSQL driver adapter.

```sh
npm ci
npm run db:generate
npm run build
npm run typecheck
DATABASE_URL=postgresql://user:password@host:5432/database npm run db:validate
```

To apply migrations and run the database integration tests against a disposable PostgreSQL database:

```sh
DATABASE_URL=postgresql://user:password@host:5432/test_database npm run db:migrate
DATABASE_URL=postgresql://user:password@host:5432/test_database npm run test:db
```

Tests create isolated UUID fixtures and remove their own rows. They cover foreign keys, status validation, unique env keys, job uniqueness, concurrent deployment insertion, and transaction rollback. They do not use a mocked database or Docker engine.

For host-side web development, provide a reachable `DATABASE_URL`, build the shared package, then run `npm run dev`. Compose intentionally does not publish the database; use a separate local PostgreSQL instance or an explicit local-only Compose override.

## Next phases

1. Resource-limited containers, health gates, and Caddy route switching.
2. Rollback, stop, crash recovery, and reconciliation.
3. Deployment dashboard, SSE, and end-to-end failure tests.

## Phase 2 API

Auth responses include `user: { id, email, createdAt }`. Password hashes are never returned. Email addresses are trimmed and lowercased. Passwords require 12 characters minimum and 1024 UTF-8 bytes maximum. Sessions expire after seven days.

| Method | Path | Behavior |
| --- | --- | --- |
| POST | /api/auth/signup | Create user, set session cookie, return 201; duplicate email 409 |
| POST | /api/auth/login | Verify credentials, set session cookie, return 200; incorrect credentials 401 |
| POST | /api/auth/logout | Clear cookie, return 200 |
| GET | /api/auth/me | Current user or 401 |
| POST | /api/projects | Validate public GitHub repo, create project and encrypted env rows atomically |
| GET | /api/projects | Owned projects, latest deployment metadata, active URL or null |
| GET | /api/projects/:id | Owned project, env keys only, newest-first deployment history |
| PATCH | /api/projects/:id | Update branch, port, health path, and environment variables |

All project routes require authentication. Missing projects and other users' projects return identical 404 responses. Project responses use snake_case fields. The list uses `latest_deployment: { id, status, created_at }` or null. Details return `environment_variables` as an array of keys. No endpoint returns plaintext or encrypted variable values. Project deletion is not part of Phase 2.

Create request example:

```json
{
  "name": "My app",
  "repo_url": "https://github.com/owner/repository",
  "branch": "main",
  "port": 3000,
  "health_check_path": "/health",
  "environment_variables": { "API_TOKEN": "secret-value" }
}
```

PATCH accepts only `branch`, `port`, `health_check_path`, and `environment_variables`. Omitted variables remain unchanged, string values create or replace a variable, and null deletes it. Empty strings are valid values. Unknown fields are rejected. Mutations use JSON bodies limited to 128 KiB. Validation failures return 422 with a `fields` object when field-specific. Repository HEAD checks use a five-second timeout and reject redirects, non-200 responses, and network errors.

### Session and encryption configuration

- `SESSION_SECRET`: independent 32-byte random key as 64 hex characters. Rotating it invalidates all sessions.
- `ENCRYPTION_KEY`: independent 32-byte random key as 64 hex characters. Back it up securely; changing it without migrating existing ciphertext makes stored variables unreadable.
- `APP_ORIGIN`: exact browser origin, such as `http://localhost:3000`. Use `http://localhost:8080` when accessing the control plane through Caddy. Browser writes from other origins are rejected. HTTPS sets Secure cookies; localhost HTTP is supported for development. Without APP_ORIGIN, production cookies default to Secure.
- `PUBLIC_PROTOCOL`: optional `http` or `https` scheme for generated deployment URLs (default http). Base domain and port retain the foundation defaults.

Cookies are HTTP-only, host-only, SameSite=Lax and signed with HMAC-SHA256. Do not reuse session keys for encryption. Logout clears the browser cookie; a previously copied stateless cookie remains valid until expiry or key rotation. Per-session server-side revocation is not implemented. Web never decrypts stored project values on its read paths. Encryption helpers are shared through `packages/db`; only the worker decrypts environment values during build processing, for log redaction. Ciphertext is versioned and authenticates the project UUID and variable key as additional data.

### Phase 2 tests

```sh
npm run test:security
DATABASE_URL=postgresql://user:password@host:5432/test_database npm test
```

The suite uses real PostgreSQL for persistence, uniqueness, transactions, and ownership tests. API integration tests invoke the route handlers with real Request/Response objects. Only outbound GitHub API and HEAD responses are stubbed for deterministic success, redirect, and failure scenarios; production code always performs the real HEAD request. Docker builds and statuses are never mocked. CI runs these tests, the production build, and Docker Compose startup. Authentication has no UI yet; the dashboard arrives in a later phase.

## Phase 3 deployment API and worker

| Method | Path | Behavior |
| --- | --- | --- |
| POST | /api/projects/:id/deployments | Resolve an immutable commit and atomically enqueue; 201 with deployment_id and queued status |
| GET | /api/projects/:id/deployments | Owned project history, newest first |
| GET | /api/deployments/:id | Owned deployment metadata, build timestamps, failure reason and stable project_url |

POST accepts `{}` or `{ "commit_sha": "abcdef1" }`. An omitted body is also allowed. A supplied SHA must contain 7 to 40 hexadecimal characters. Both short SHAs and branch names are resolved through GitHub's commit API to a full 40-character SHA. A short prefix that does not match the resolved commit is rejected. Missing or inaccessible refs, GitHub rate limits and network errors return 422 without creating queue rows. Requests require session authentication and ownership; cross-user access returns 404. An existing queued, cloning, building, or starting deployment returns 409.

The project URL is a stable derived address, not evidence that this build is serving requests. Phase 3 does not change Caddy routes or active_deployment_id.

### Build stages

1. Claim the oldest pending job with SKIP LOCKED. Store worker identity and database claim time; transition queued to cloning in the same transaction.
2. Decrypt environment values in worker memory using the project UUID and key as authenticated encryption context. Never pass these values as Docker build arguments or Git subprocess environment variables.
3. Create an exclusive `/tmp/deploydeck/<deployment_id>/` directory. Run parameterized Git commands with prompts, global config, hooks, non-HTTPS protocols and redirects disabled. Checkout the exact SHA and verify HEAD. The combined clone/checkout budget is two minutes.
4. Check for a regular root Dockerfile. Missing Dockerfiles fail with `Missing Dockerfile in repository root` before any build request. Repository submodules are not initialized.
5. Transition to building and set build_started_at. Upload a tar context through dockerode, respecting .dockerignore, always excluding .git, and never dereferencing symlinks. Run the Docker Engine classic builder with a ten-minute deadline, 256 MiB memory and 0.5 CPU build limits. The host must support the classic builder API (`version=1`); BuildKit-only hosts are not supported in this phase.
6. Parse real Engine JSON output incrementally and await log inserts for backpressure. Redact non-empty environment values, including values split across output chunks. Multiline values also redact their individual non-empty lines. Oversized output records or lines fail safely rather than consuming unbounded memory. Failure reasons are redacted too.
7. Require a Docker success record and verify the resulting image ID through the Engine image listing. Save `deploydeck/<project_id>:<first-12-SHA-characters>`, build_finished_at, and starting status. This is the Phase 4 handoff.
8. Always remove an owned workspace in finally, and mark the claimed job done in the polling loop's finally block. SIGTERM/SIGINT stops new claims, kills active Git process groups or aborts active Docker requests, records the failure when possible, and cleans up.

Every status transition uses an expected prior status in its UPDATE predicate. Invalid transitions and stale workers cannot overwrite newer state. Phase 3 accepts only queued -> cloning -> building -> starting, plus failure from cloning/building. Failed deployments cannot transition again.

A successful Phase 3 build stays at starting with a done job and blocks another deployment for that project. Phase 4 must continue those persisted image candidates or call the runtime stage immediately after `buildPreparedDeployment`. No container is started in this phase. Crash recovery for SIGKILL or host failure, retention policies, disk quotas, and build-network egress restrictions remain future work. A clean shutdown cannot guarantee daemon-side cancellation during a network partition; reconciliation will handle orphaned resources later.

### Verify real builds

```sh
DATABASE_URL=postgresql://user:password@host:5432/test_database npm run db:migrate
DATABASE_URL=postgresql://user:password@host:5432/test_database npm test
REQUIRE_DOCKER_TESTS=1 DATABASE_URL=postgresql://user:password@host:5432/test_database npm run test:worker
```

The full suite runs files sequentially because queue tests deliberately claim globally pending jobs. Use a disposable test database with no running worker. Real Docker tests build a network-independent FROM scratch fixture, verify the image exists, check error redaction with a failing COPY, and exercise cancellation. They remove their images afterward. Without a Docker socket this test reports an explicit skip; `REQUIRE_DOCKER_TESTS=1` turns missing Docker into failure and is mandatory in CI. Docker operations and build logs are never mocked. `DOCKER_SOCKET` defaults to `/var/run/docker.sock`.
