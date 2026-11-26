# Verification and live demo

## Automated acceptance

Run from the repository root on Linux or WSL with Node.js 22.12+, npm, Git, tar, Docker Engine and Compose v2. The test user needs access to the Docker socket and localhost-published container ports. Use a disposable Docker host or one dedicated to this application. The worker and tests inspect host-level container state.

Use a separate PostgreSQL database for tests. The commands below launch one on a dynamically assigned loopback port and remove only that container and its anonymous volume on exit.

```bash
(
  set -eu
  db_container=$(docker run -d -e POSTGRES_PASSWORD=test_local -e POSTGRES_DB=deploydeck_test \
    -p 127.0.0.1::5432 postgres:17-bookworm)
  trap 'docker rm -fv "$db_container" >/dev/null' EXIT
  until docker exec "$db_container" pg_isready -U postgres -d deploydeck_test >/dev/null; do sleep 1; done
  binding=$(docker port "$db_container" 5432/tcp)
  export DATABASE_URL="postgresql://postgres:test_local@127.0.0.1:${binding##*:}/deploydeck_test"
  export REQUIRE_DOCKER_TESTS=1 NEXT_TELEMETRY_DISABLED=1

  npm ci
  npm run db:validate
  npm run build
  npm run typecheck
  npm run db:migrate
  npm run db:migrate
  npm audit
  npm test
)
```

The production build is required by the HTTP route tests. A passing run reports zero failures and zero skips. The acceptance test starts a real Next.js server, signs up over HTTP and sends two simultaneous deploy requests. Check for one 201, one 409 and one queued job. It verifies v1, v2, failed replacement, v1 image reuse and manual stop in that order. Test-only GitHub metadata responses and a local pinned Git fixture make the revisions reproducible. PostgreSQL, image builds, containers, HTTP health checks and Caddy routing run locally.

Additional cases cover state guards, owner-only API access, unsafe input rejection, secret redaction, host resource limits, runtime failure, image retention, signal handling, drift, SSE replay and live tailing. The workflow in [verify.yml](.github/workflows/verify.yml) runs the full suite, production dependency audit and Compose smoke checks.

## Start and inspect the platform

```sh
npm run setup
docker compose up --build -d --wait
docker compose ps
curl --fail http://localhost:3000/api/health
docker compose exec -T caddy caddy validate --config /etc/caddy/caddy.json
```

Expect four healthy services. The following prints only mount destinations. Web should have none. The worker should show the Docker socket and Caddy admin directory.

```sh
docker inspect --format '{{range .Mounts}}{{println .Destination}}{{end}}' "$(docker compose ps -q web)"
docker inspect --format '{{range .Mounts}}{{println .Destination}}{{end}}' "$(docker compose ps -q worker)"
```

## Live lifecycle checklist

Use a disposable project in a public GitHub repository you control. Copy the contents of `tests/fixtures/lifecycle-http/` to its root and commit them as v1. For v2 append `ENV APP_VERSION=v2` to the Dockerfile and commit again. Record both commit SHAs. For a broken revision commit the Dockerfile from `tests/fixtures/lifecycle-build-failure/`. Keep `APP_VERSION` unset in project settings so image defaults identify the revision served.

1. **Deploy v1.** Sign up at [the dashboard](http://localhost:3000). Create a project with port 3000 and health path `/health`. Deploy the v1 SHA. Open Build logs to inspect the Docker build output and Runtime logs to see the listening message. The project URL should return `v1`.
2. **Inspect limits.** Set `id` to the deployment UUID from its dashboard URL. List and inspect the running container.

   ```sh
   docker ps --filter "name=dd-$id"
   docker inspect --format 'memory={{.HostConfig.Memory}} cpu={{.HostConfig.NanoCpus}} pids={{.HostConfig.PidsLimit}} privileged={{.HostConfig.Privileged}} binds={{json .HostConfig.Binds}} network={{.HostConfig.NetworkMode}}' "dd-$id"
   docker port "dd-$id"
   ```

   Expect 268435456 bytes, 500000000 NanoCPUs, 128 PIDs, false, no binds, a `dd-net-<project-id>` network and a host port from 20000 through 29999.
3. **Replace v1.** Deploy the v2 SHA. The same project URL should now return `v2`. The v1 row should be stopped with a timestamp, and `docker ps -a --filter "name=dd-$id"` should show no v1 container.
4. **Check failure isolation.** Deploy the broken SHA. Its build log and failure reason should identify the missing file. The project URL should still return `v2`. In settings add `FIXTURE_MODE=unhealthy`, deploy the working v1 SHA and verify a failed health check and removal of the candidate. Check v2 again. Remove that variable before the rollback.
5. **Roll back without rebuilding.** Choose Rollback on the original stopped v1. Verify the new deployment has the retained image tag, empty build-start and build-finish timestamps, a healthy container, and the project URL returns `v1`.
6. **Observe external drift.** Set `id` to this new healthy test deployment. Run `docker kill "dd-$id"` and check `docker compose logs --since 2m worker`. Within a reconciliation interval plus processing time, expect `container exited unexpectedly` and a failed deployment. The last Caddy route remains configured and can report an unavailable upstream.
7. **Stop a healthy version.** Roll back to a previously successful stopped revision. After it is healthy, select Stop container. Confirm its stopped timestamp, removed container and removal of the active route.

## Cleanup and CI evidence

On a dedicated test host, these commands should return no test resources after the automated suite. A manual demo can leave its stopped external-kill container, project network and intentionally retained images. Identify those by project before cleaning up.

```sh
docker ps -a --filter 'name=^/dd-' --format '{{.Names}}'
docker network ls --filter name=dd-net- --format '{{.Name}}'
docker image ls --filter 'reference=deploydeck/*' --format '{{.Repository}}:{{.Tag}}'
if [ -d /tmp/deploydeck ]; then find /tmp/deploydeck -mindepth 1 -maxdepth 1 -print; fi
docker compose exec -T worker sh -c 'if [ -d /tmp/deploydeck ]; then ls -A /tmp/deploydeck; fi'
```

To match a GitHub Actions result to the checkout, run `git rev-parse HEAD`, then `gh run list --branch main --commit "$(git rev-parse HEAD)"`. Inspect the matching run with `gh run view RUN_ID` and `gh run view RUN_ID --log`. Confirm the test totals, audit, Compose health and Caddy validation.
