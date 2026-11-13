-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "repo_url" TEXT NOT NULL,
    "branch" TEXT NOT NULL DEFAULT 'main',
    "port" INTEGER NOT NULL,
    "health_check_path" TEXT NOT NULL DEFAULT '/',
    "active_deployment_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "environment_variables" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value_encrypted" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "environment_variables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "commit_sha" TEXT NOT NULL,
    "image_tag" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "failure_reason" TEXT,
    "container_id" TEXT,
    "host_port" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "queued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "build_started_at" TIMESTAMPTZ(6),
    "build_finished_at" TIMESTAMPTZ(6),
    "started_at" TIMESTAMPTZ(6),
    "healthy_at" TIMESTAMPTZ(6),
    "stopped_at" TIMESTAMPTZ(6),

    CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployment_logs" (
    "id" BIGSERIAL NOT NULL,
    "deployment_id" UUID NOT NULL,
    "phase" TEXT NOT NULL,
    "line" TEXT NOT NULL,
    "ts" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployment_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployment_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "deployment_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "claimed_at" TIMESTAMPTZ(6),
    "claimed_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployment_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "projects_user_id_idx" ON "projects"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "environment_variables_project_id_key_key" ON "environment_variables"("project_id", "key");

-- CreateIndex
CREATE INDEX "deployments_project_id_status_idx" ON "deployments"("project_id", "status");

-- CreateIndex
CREATE INDEX "deployments_project_id_created_at_idx" ON "deployments"("project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "deployment_logs_deployment_id_ts_idx" ON "deployment_logs"("deployment_id", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "deployment_jobs_deployment_id_key" ON "deployment_jobs"("deployment_id");

-- CreateIndex
CREATE INDEX "deployment_jobs_status_created_at_idx" ON "deployment_jobs"("status", "created_at");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_active_deployment_id_fkey" FOREIGN KEY ("active_deployment_id") REFERENCES "deployments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "environment_variables" ADD CONSTRAINT "environment_variables_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployment_logs" ADD CONSTRAINT "deployment_logs_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployment_jobs" ADD CONSTRAINT "deployment_jobs_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Prisma cannot express these CHECK constraints or partial indexes in its schema.
ALTER TABLE "projects" ADD CONSTRAINT "projects_port_check" CHECK (port BETWEEN 1 AND 65535);
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_status_check"
  CHECK (status IN ('queued','cloning','building','starting','healthy','failed','stopping','stopped'));
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_host_port_check"
  CHECK (host_port IS NULL OR host_port BETWEEN 1 AND 65535);
ALTER TABLE "deployment_logs" ADD CONSTRAINT "deployment_logs_phase_check" CHECK (phase IN ('build','runtime'));
ALTER TABLE "deployment_jobs" ADD CONSTRAINT "deployment_jobs_status_check" CHECK (status IN ('pending','claimed','done'));
CREATE UNIQUE INDEX "deployments_one_in_flight_per_project" ON "deployments" ("project_id")
  WHERE status IN ('queued','cloning','building','starting');
CREATE INDEX "deployment_jobs_pending" ON "deployment_jobs" ("created_at", "id") WHERE status = 'pending';
