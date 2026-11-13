# DeployDeck

Single-host PaaS foundation using Next.js App Router, TypeScript, PostgreSQL, Prisma, Docker Engine, and Caddy.

## Current scope

Phase 1 provides a web application, database readiness endpoint, six-table schema and migration, worker bootstrap, and Compose infrastructure. Authentication, job execution, container builds, deployment routing, rollback, and log streaming are not implemented yet. There are no simulated deployments.

## Start locally

Install Docker Engine with Compose v2, or Docker Desktop using Linux containers. From the repository root:

```sh
docker compose up --build
```

No environment file is required for local defaults. Open http://localhost:3000 or http://localhost:8080. PostgreSQL becomes healthy first, the web process applies migrations and starts, and the worker starts after web and proxy readiness. The worker verifies database connectivity, performs a real Docker Engine ping, and reads Caddy configuration through its Unix admin socket.

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

The worker is a trusted host administrator because it holds the Docker socket. It runs as root for portable socket access in this local setup. The web process runs as an unprivileged user. Do not expose this Phase 1 setup on a public server; authentication is a later phase and the database credentials are local development defaults.

## Networking for the deployment pipeline

The planned stable app URL is `http://project-<uuid>.localhost:8080`. `BASE_DOMAIN` and `PUBLIC_PORT` are configurable. The future worker must create the host match for that domain after a passing health check.

Inside the Caddy container, `localhost` refers to Caddy itself. Future upstreams must therefore use `host.docker.internal:<allocated-host-port>`, not `localhost:<port>`. Both worker and Caddy have the Linux host-gateway mapping. Published deployment ports must be reachable through that gateway; binding them only to host loopback will not work on Linux. Per-project networks, port allocation, resource limits, health checks, and firewall restrictions arrive with the real container pipeline.

## Database guarantees

Six application tables: users, projects, environment_variables, deployments, deployment_logs, deployment_jobs. Prisma adds its migration bookkeeping table.

The SQL migration supplements Prisma with CHECK constraints and a partial unique index limiting each project to one queued, cloning, building, or starting deployment. It also supplies a pending-job index. Future enqueue and claim code must still use transactions and `FOR UPDATE SKIP LOCKED`; constraints do not implement the queue by themselves.

`deployments.created_at` is included because deployment history requires its descending index. Log IDs are bigint and must be serialized as strings in future JSON/SSE endpoints. Environment values have an encrypted-value column; encryption itself is Phase 2.

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

1. Authentication, ownership checks, repository validation, and encrypted environment variables.
2. Durable queue claims, pinned Git checkout, real Docker builds, and redacted logs.
3. Resource-limited containers, health gates, and Caddy route switching.
4. Rollback, stop, crash recovery, and reconciliation.
5. Deployment dashboard, SSE, and end-to-end failure tests.
