FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/db/package.json ./packages/db/package.json
COPY packages/db/prisma ./packages/db/prisma
COPY packages/db/prisma.config.ts ./packages/db/prisma.config.ts
COPY apps/web/package.json ./apps/web/package.json
COPY apps/worker/package.json ./apps/worker/package.json
RUN npm ci
COPY packages/db ./packages/db
RUN npm run db:generate && npm run build -w @deploydeck/db

FROM base AS web-build
COPY apps/web ./apps/web
RUN npm run build -w @deploydeck/web

FROM web-build AS web
ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["sh", "-c", "npm run db:migrate && exec node node_modules/next/dist/bin/next start apps/web --hostname 0.0.0.0"]

FROM base AS worker-build
COPY apps/worker ./apps/worker
RUN npm run build -w @deploydeck/worker

FROM worker-build AS worker
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
CMD ["node", "apps/worker/dist/index.js"]
