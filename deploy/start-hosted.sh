#!/bin/bash
# BLACKHOLE Terminal — hosted single-container supervisor (Fly.io / Render /
# Railway). One container runs ALL THREE processes:
#
#   1. stream sidecar  — bun /svc/index.ts          (socket.io, :3030)
#   2. Next app        — docker-entrypoint.sh       (db push → bun server.js, :3000)
#   3. Caddy edge      — deploy/Caddyfile.hosted    (one public :$EDGE_PORT)
#
# Why one container? Serverless-style PaaS platforms deploy ONE routable port
# per service and (on Render/Railway) charge per service — the docker-compose
# two-container layout doesn't map onto them. Inside one network namespace the
# app's own /api/health stream probe (127.0.0.1:3030) and the stream service's
# Next rescue probe (127.0.0.1:3000) both work unmodified.
#
# Port contract (the tricky bit):
#   $PORT     — set by the PLATFORM (Render/Railway inject it; Fly uses
#               fly.toml's internal_port and injects nothing). This is the
#               PUBLIC edge port → forwarded to Caddy as $EDGE_PORT.
#   PORT=3000 — forced for the app's standalone server (Caddy's upstream).
#               The entrypoint's standalone server binds $PORT, so it MUST be
#               re-pointed away from the edge port before it starts.
set -u

EDGE_PORT="${PORT:-8080}"
export EDGE_PORT
export PORT=3000
export NODE_ENV=production

echo "[hosted] edge :${EDGE_PORT} → app :3000 + stream :3030 (db: ${DATABASE_URL:-<entrypoint default>})"

# 1) stream sidecar — socket.io fan-out (crypto via Binance, stocks via the
#    account's single Alpaca iex websocket; handshake auth via $AUTH_SECRET).
(cd /svc && exec bun index.ts) &
STREAM_PID=$!

# 2) the app — reuse the production entrypoint verbatim: it validates
#    DATABASE_URL, runs `prisma db push`, then execs `bun server.js`.
/usr/local/bin/docker-entrypoint.sh &
APP_PID=$!

# 3) Caddy edge — the only process the platform routes to.
caddy run --config /etc/caddy/Caddyfile.hosted --adapter caddyfile &
EDGE_PID=$!

shutdown() {
  trap - TERM INT
  kill "$APP_PID" "$STREAM_PID" "$EDGE_PID" 2>/dev/null || true
  wait "$APP_PID" "$STREAM_PID" "$EDGE_PID" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

# If ANY of the three dies the container is broken — exit non-zero so the
# platform's restart policy replaces it (same contract as compose's
# `restart: unless-stopped`, which PaaS platforms implement per-container).
wait -n "$APP_PID" "$STREAM_PID" "$EDGE_PID" || true
CODE=$?
echo "[hosted] a process exited (code=${CODE}) — stopping so the platform restarts the container"
shutdown
