# DeployDeck

DeployDeck turns a public GitHub repository with a root Dockerfile into a running HTTP service on one Docker host. Use the dashboard to deploy a pinned commit, follow build and runtime logs, and switch back to a retained image. Each project has a stable Caddy URL. A failed build or startup health check leaves the previous healthy version serving.

## Start locally

Use Linux or Ubuntu WSL with Docker Engine or Docker Desktop in Linux-container mode, Compose v2, and Node.js 22.12 or newer with npm. The host needs network access to GitHub and to the registries used by the Dockerfiles.

```sh
npm run setup
docker compose up --build -d
docker compose ps
```

Setup creates an ignored, owner-readable `.env` with independent random keys on first use. If configuring manually, copy `.env.example` to `.env` and fill both blank key fields with separately generated values. Setup preserves an existing file. Back up the encryption key with the database or stored project secrets will become unreadable.

| Setting | Purpose |
| --- | --- |
| `SESSION_SECRET`, `ENCRYPTION_KEY` | Each is 32 random bytes encoded as 64 hex characters. Generate each with `node -p "require('node:crypto').randomBytes(32).toString('hex')"`. |
| `APP_ORIGIN` | Browser origin, default `http://localhost:3000`. Browser mutations check the supplied Origin header. HTTPS enables Secure session cookies. |
| `BASE_DOMAIN`, `PUBLIC_PORT`, `PUBLIC_PROTOCOL` | Project URL defaults to `http://project-<id>.localhost:8080`. Custom domains require DNS and matching ingress configuration. |
| `DATABASE_URL` | Host-side scripts use this connection string. Compose supplies an internal PostgreSQL URL to its services. |
| `STARTUP_TIMEOUT`, `STALE_JOB_GRACE_MS`, `RECONCILE_INTERVAL_MS` | Worker startup health deadline, stale claim age and drift check interval. Defaults in milliseconds are 60000, 60000 and 15000. |

1. Open [the dashboard](http://localhost:3000), create an account and select **New project**.
2. Enter a public repository, branch, container port and HTTP health path. The app must listen on the configured port on all container interfaces. Add any runtime environment variables.
3. Select **Deploy now**. The worker checks out the resolved commit and builds the root Dockerfile. The deployment page shows its status, timestamps and phase-filtered logs.
4. Open the project URL after its health check succeeds. Use deployment history to roll back to a retained successful image or stop the active version.

`docker compose down` stops the platform services. The PostgreSQL volume persists. Project containers are managed by the worker and can be stopped through the dashboard before taking the platform down.

## Architecture

| Component | Responsibility |
| --- | --- |
| Next.js web | Authenticates users, validates project configuration, records deployment requests and streams persisted logs. It receives neither the Docker socket nor Caddy's admin socket. |
| PostgreSQL | Stores users, encrypted variables, projects, deployments, jobs and logs. Enqueue holds a project-row lock and writes the deployment and job in one transaction. A partial unique index enforces one in-flight deployment per project. |
| Worker | Claims pending jobs using `FOR UPDATE SKIP LOCKED`. It owns Git checkout, Docker builds, runtime health checks, log capture and Caddy route updates. |
| Caddy | Matches project hostnames to allocated host ports through `host.docker.internal`. Its admin API listens on a Unix socket in a volume shared with the worker. |

| Event | State changes and effects |
| --- | --- |
| New deploy | `queued -> cloning -> building -> starting -> healthy`. The worker checks the container and its HTTP endpoint before replacing the project route and recording the active deployment. |
| Build or startup failure | The candidate reaches `failed` with a reason. Failed startup containers are removed. |
| Replacement or manual stop | The old deployment goes from `healthy -> stopping -> stopped`. The worker removes its container. Stopping the active deployment also removes its route. |
| Rollback | A new job goes from `queued -> starting` with the source image tag and current project environment. It passes the normal health gate. Build timestamps stay null. A missing image fails the candidate. The retention policy keeps the five newest distinct successful tags and protects tags still referenced by containers. |
| Restart or drift | Startup fails expired claimed builds or startups that lack a running container. Periodic reconciliation marks unexpectedly exited healthy deployments failed and logs orphan containers. Drift keeps the last route configuration, so a dead upstream can return a proxy error until a healthy version is deployed. |

The worker handles SIGINT and SIGTERM, stops taking new work, drains or aborts the current operation, closes runtime log streams and disconnects from PostgreSQL.

## HTTP API

Authenticated endpoints use the `deploydeck_session` cookie. Missing or invalid sessions receive 401. Unknown and cross-user project or deployment IDs receive 404. Invalid inputs receive 422 with field details where available.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/health` | Database readiness |
| POST | `/api/auth/signup`, `/api/auth/login`, `/api/auth/logout` | Create an account, establish a session or clear its cookie |
| GET | `/api/auth/me` | Current user |
| GET, POST | `/api/projects` | List owned projects or create a project |
| GET, PATCH | `/api/projects/:id` | Read configuration and history or update branch, port, health path and environment variables |
| GET, POST | `/api/projects/:id/deployments` | Read history or enqueue a build. Optional `commit_sha` accepts 7 to 40 hex characters. Creation returns 201, an in-flight conflict returns 409. |
| GET | `/api/deployments/:id`, `/api/deployments/:id/health` | Deployment metadata or the worker's recorded health and routing state |
| GET | `/api/deployments/:id/logs` | SSE history followed by live `log` and `status` events. Log IDs are decimal strings. `done` ends a failed or stopped stream. |
| POST | `/api/deployments/:id/rollback`, `/api/deployments/:id/stop` | Enqueue image reuse or request a worker-managed stop. Accepted requests return 202. |

Project creation accepts `name`, `repo_url`, `port`, optional `branch` (default `main`), `health_check_path` (default `/`) and an `environment_variables` key-value object. In a PATCH, omitted keys are preserved, strings set or replace values, and null removes a key. Project details return the keys with no stored values.

## Security model and MVP limits

- Passwords use salted scrypt hashes. Sessions use signed, expiring HttpOnly cookies. Project variables use AES-256-GCM with project and key context. The worker redacts configured values from persisted build and runtime lines. The viewer renders text through React.
- The web process uses an unprivileged user, dropped capabilities and no runtime administration mounts. The worker holds the Docker socket and must be trusted as a host administrator.
- Repository input accepts public HTTPS GitHub owner/repository paths. Git uses argument arrays, pinned checkouts, disabled redirects and restricted protocols. Each build has a private per-deployment directory, removed in a finally block during normal or aborted execution. Clone and build deadlines are two and ten minutes.
- Each app runs unprivileged with all capabilities dropped, no new privileges, no host binds, 256 MiB of memory, 0.5 CPU and a PID limit of 128. Each project uses its own Docker bridge. The worker checks for HTTP 2xx without following redirects.
- Containers share the host kernel. Builds process user-controlled Dockerfiles and bridge networks have outbound access by default. Stronger tenant isolation with gVisor or Firecracker, egress policies and base-image vulnerability scanning are future work. The npm audit covers JavaScript dependencies.
- Compose publishes the dashboard and Caddy on loopback. Deployed apps publish ports 20000-29999 on all host interfaces for gateway routing. Restrict those ports at the host firewall before exposing the machine. Compose ships local database credentials and HTTP defaults.

See [Verification and live demo](VERIFICATION.md) for the reproducible test environment and operator checks.
