# PCP production image: one container, one SQLite file under /data.
#
#   docker compose up -d      # see docker-compose.yaml
#
# Nothing has to be configured: the first visit to the site sets up the
# owner. Keep the /data volume — it is the vault.

FROM node:22-bookworm-slim AS base

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1

RUN corepack disable \
  && npm install -g --no-update-notifier pnpm@10.33.0

FROM base AS deps

# better-sqlite3 downloads a prebuilt binary when one exists for the
# platform and compiles from source otherwise. Only this stage has a
# toolchain; the runner copies the finished module.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

FROM base AS builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production

RUN pnpm db:generate
RUN pnpm build

FROM base AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    PCP_DATA_DIR=/data

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs pcp \
  && mkdir -p /data \
  && chown pcp:nodejs /data

COPY --from=builder /app/public ./public
COPY --from=builder --chown=pcp:nodejs /app/.next/standalone ./
COPY --from=builder --chown=pcp:nodejs /app/.next/static ./.next/static
# Applied at boot by instrumentation.ts (lib/core/migrate.ts).
COPY --from=builder /app/prisma/migrations ./prisma/migrations

USER pcp

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
