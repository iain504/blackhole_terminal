# BLACKHOLE Terminal — production image (Task 11-d, runner fixed in Task 13).
# Multi-stage, Bun-native, Prisma/SQLite inside. The app builds to a Next.js
# standalone bundle; the runner merges it with a production-only node_modules
# so the boot-time `prisma db push` has its complete dependency closure.
#
#   docker build -t blackhole-terminal .
#   docker run -p 3000:3000 -v "$PWD/db:/app/db" \
#     -e AUTH_SECRET=... -e APP_ENCRYPTION_SECRET=... blackhole-terminal
#
# Version stamping: stamp-version.mjs degrades gracefully without .git
# (v1.80.0-dev style). Pass --build-arg only if you need exact counters.
#
# Bun is PINNED to the 1.3 line: the floating oven/bun:1 tag shipped 1.4.4 on
# Render while this app is validated on 1.3.x (dev + all tests). Bump only
# after re-validating the full stack on the new minor.

# ---- deps: install + prisma client (cached until lockfile/schema change) ----
FROM oven/bun:1.3 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile
RUN bunx prisma generate

# ---- prisma-cli: production-only tree for the boot-time `prisma db push` -----
# The CLI's transitive runtime deps (@prisma/config → effect, c12, deepmerge-ts,
# empathic, …) change between prisma releases — cherry-picking node_modules/prisma
# + node_modules/@prisma broke the Render boot with "Cannot find package 'effect'".
# A production-only install IS the automatic, version-proof closure (no devDeps).
FROM oven/bun:1.3 AS prisma-cli
WORKDIR /app
COPY package.json bun.lock ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile --production

# ---- build: next build (standalone) + static asset copy ----------------------
FROM oven/bun:1.3 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# `bun run build` = prebuild version stamp → next build → static copy.
RUN bun run build

# ---- runner: standalone server + prisma CLI for the boot-time db push --------
FROM oven/bun:1.3 AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_URL=file:/app/db/custom.db

# Full production node_modules first (Prisma CLI closure base), then the
# standalone bundle OVER it — next's traced subset wins on overlap (identical
# versions per bun.lock), the CLI closure fills everything else.
COPY --from=prisma-cli /app/node_modules ./node_modules
# Standalone bundle (server.js + traced deps) and the static/public assets.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# Schema for the entrypoint's `prisma db push`.
COPY prisma ./prisma
# Build-time smoke test: if the CLI dependency closure is ever incomplete
# again, the image build fails HERE — never again silently at boot.
RUN bunx prisma -v > /dev/null 2>&1
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# The SQLite file lives on a volume — never bake it into the image.
RUN mkdir -p /app/db
VOLUME ["/app/db"]

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
