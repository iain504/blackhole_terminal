# BLACKHOLE Terminal — production image (Task 11-d).
# Multi-stage, Bun-native, Prisma/SQLite inside. The app builds to a Next.js
# standalone bundle; the runner copies only what the server (and `prisma db
# push` at boot) needs.
#
#   docker build -t blackhole-terminal .
#   docker run -p 3000:3000 -v "$PWD/db:/app/db" \
#     -e AUTH_SECRET=... -e APP_ENCRYPTION_SECRET=... blackhole-terminal
#
# Version stamping: stamp-version.mjs degrades gracefully without .git
# (v1.80.0-dev style). Pass --build-arg only if you need exact counters.

# ---- deps: install + prisma client (cached until lockfile/schema change) ----
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile
RUN bunx prisma generate

# ---- build: next build (standalone) + static asset copy ----------------------
FROM oven/bun:1 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# `bun run build` = prebuild version stamp → next build → static copy.
RUN bun run build

# ---- runner: standalone server + prisma CLI for the boot-time db push --------
FROM oven/bun:1 AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_URL=file:/app/db/custom.db

# Standalone bundle (server.js + traced deps) and the static/public assets.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# Prisma CLI + engines + schema for the entrypoint's `prisma db push`.
COPY --from=deps /app/node_modules/prisma ./node_modules/prisma
COPY --from=deps /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=deps /app/node_modules/.bin ./node_modules/.bin
COPY prisma ./prisma
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# The SQLite file lives on a volume — never bake it into the image.
RUN mkdir -p /app/db
VOLUME ["/app/db"]

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
