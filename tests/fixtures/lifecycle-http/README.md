# Lifecycle HTTP fixture

This fixture is intended for real Docker builds and container execution through
the worker pipeline. It listens on port 3000 and returns APP_VERSION (default
v1) from /. Use /health as the project's health-check path.

FIXTURE_MODE selects healthy (default), unhealthy (HTTP 503 on /health), timeout
(no response on /health), no-listen (process alive without a listener), or exit
(exit code 42). These are real server behaviors, not mocked HTTP responses.

The Dockerfile prints two fixed synthetic test strings during the build:
super-secret-value-123 and tok-987654. Tests must encrypt those same values as
API_SECRET_KEY and DB_TOKEN on the project to exercise build-log redaction.
At runtime the server prints the actual injected environment values on stdout
and stderr. Never supply project secrets as Docker build arguments.

The sibling lifecycle-build-failure fixture fails a real image build because
its COPY source does not exist.

Fixtures alone do not constitute lifecycle verification. The test harness must
assert database transitions, resource limits, Caddy responses, log redaction,
and cleanup using real services and a disposable database.