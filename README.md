# DeployDeck

Single-host PaaS foundation using Next.js App Router, TypeScript, PostgreSQL, Prisma, Docker Engine, and Caddy.

## Current scope

Phases 1 and 2 provide the foundation, signed-cookie authentication, and owned project APIs with encrypted environment variables. Job execution, container builds, deployment routing, rollback, and log streaming are not implemented yet. There are no simulated deployments.

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
- `apps/worker`: standalone daemon. It alone receives the Docker socket and the client mount of Caddy's admin socket. It intentionally does not claim jobs in Phase 1.
- `packages/db`: shared Prisma client, schema, and versioned SQL migrations.
- `infra/caddy`: proxy configuration with a dedicated dynamic route insertion point (`project-routes`). Unknown project hosts return 404.

Caddy admin listens only on a Unix socket, never on a TCP port. Sharing the public ingress network with web therefore does not expose its admin API. PostgreSQL uses a private internal network and has no published port. Only localhost can reach the UI and proxy ports by default.

The worker is a trusted host administrator because it holds the Docker socket. It runs as root for portable socket access in this local setup. The web process runs as an unprivileged user. This is a local development setup. Before public hosting, configure HTTPS, production database credentials, and a shared login rate limiter.

## Networking for the deployment pipeline

The planned stable app URL is `http://project-<uuid>.localhost:8080`. `BASE_DOMAIN` and `PUBLIC_PORT` are configurable. The future worker must create the host match for that domain after a passing health check.

Inside the Caddy container, `localhost` refers to Caddy itself. Future upstreams must therefore use `host.docker.internal:<allocated-host-port>`, not `localhost:<port>`. Both worker and Caddy have the Linux host-gateway mapping. Published deployment ports must be reachable through that gateway; binding them only to host loopback will not work on Linux. Per-project networks, port allocation, resource limits, health checks, and firewall restrictions arrive with the real container pipeline.

## Database guarantees

Six application tables: users, projects, environment_variables, deployments, deployment_logs, deployment_jobs. Prisma adds its migration bookkeeping table.

The SQL migration supplements Prisma with CHECK constraints and a partial unique index limiting each project to one queued, cloning, building, or starting deployment. It also supplies a pending-job index. Future enqueue and claim code must still use transactions and `FOR UPDATE SKIP LOCKED`; constraints do not implement the queue by themselves.

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

1. Durable queue claims, pinned Git checkout, real Docker builds, and redacted logs.
2. Resource-limited containers, health gates, and Caddy route switching.
3. Rollback, stop, crash recovery, and reconciliation.
4. Deployment dashboard, SSE, and end-to-end failure tests.

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

Cookies are HTTP-only, host-only, SameSite=Lax and signed with HMAC-SHA256. Do not reuse session keys for encryption. Logout clears the browser cookie; a previously copied stateless cookie remains valid until expiry or key rotation. Per-session server-side revocation is not implemented. Web never decrypts stored project values on its read paths. The decrypt helper exists for the upcoming worker integration. Ciphertext is versioned and authenticates the project UUID and variable key as additional data.

### Phase 2 tests

```sh
npm run test:security
DATABASE_URL=postgresql://user:password@host:5432/test_database npm test
```

The suite uses real PostgreSQL for persistence, uniqueness, transactions, and ownership tests. API integration tests invoke the route handlers with real Request/Response objects. Only outbound GitHub HEAD responses are stubbed for deterministic success, redirect, and failure scenarios; production code always performs the real HEAD request. Docker builds and statuses are never mocked. CI runs these tests, the production build, and Docker Compose startup. Authentication has no UI yet; the dashboard arrives in a later phase.
