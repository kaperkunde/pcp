# PCP production image: one container, one SQLite file under /data.
#
#   docker compose up -d      # see docker-compose.yaml
#
# Nothing has to be configured: the first visit to the site sets up the
# owner. Keep the /data volume — it is the vault.
#
# HTTPS is optional and off until turned on in Settings. When it is on, PCP
# also listens on 8080 (plain HTTP, for Let's Encrypt and the redirect) and
# 8443 (HTTPS): docker-compose.https.yaml maps them to 80 and 443.

FROM node:24-bookworm-slim AS base

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

# PCP runs as an unprivileged user, so its own HTTPS listeners use ports
# above 1024; the compose file maps 80 and 443 onto them. PCP_CONTAINER lets
# Settings say how a container is updated (lib/server/install-kind.ts).
ENV NODE_ENV=production \
    PCP_CONTAINER=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    PCP_DATA_DIR=/data \
    PCP_HTTP_PORT=8080 \
    PCP_HTTPS_PORT=8443

# /run/pcp-sandbox is where PCP listens for run_code's sandbox, when
# docker-compose.sandbox.yaml adds it: a volume there takes this directory's
# owner and mode, so only PCP and its group reach the socket.
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs pcp \
  && mkdir -p /data /run/pcp-sandbox \
  && chown pcp:nodejs /data /run/pcp-sandbox \
  && chmod 0770 /run/pcp-sandbox

# The browser (lib/core/browser/): Playwright's build of Chromium and the
# libraries it needs, the version the app's playwright-core drives
# (scripts/docker.test.ts keeps the two the same). It only runs once the
# owner adds the browser and a page is opened. An unprivileged container
# has no user namespaces for Chromium's own sandbox, so it runs without
# one; PCP's proxy and address checks are not that sandbox's job.
ARG PLAYWRIGHT_VERSION=1.63.0
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PCP_BROWSER_SANDBOX=off
RUN npx -y --no-update-notifier playwright-core@${PLAYWRIGHT_VERSION} install --with-deps chromium \
  && chmod -R a+rX /ms-playwright \
  && rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache

COPY --from=builder /app/public ./public
COPY --from=builder --chown=pcp:nodejs /app/.next/standalone ./
COPY --from=builder --chown=pcp:nodejs /app/.next/static ./.next/static
# Applied at boot by instrumentation.ts (lib/core/migrate.ts).
COPY --from=builder /app/prisma/migrations ./prisma/migrations

USER pcp

VOLUME ["/data"]
EXPOSE 3000 8080 8443

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
