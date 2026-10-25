#!/bin/sh
# BLACKHOLE Terminal container entrypoint (Task 11-d).
# 1. ensure the SQLite directory exists
# 2. apply the Prisma schema (db push) — safe to run on every boot
# 3. exec the standalone Next.js server
set -e

: "${DATABASE_URL:=file:/app/db/custom.db}"
export DATABASE_URL
mkdir -p /app/db

echo "[entrypoint] applying prisma schema to ${DATABASE_URL}…"
# DB_PUSH_ACCEPT_DATA_LOSS=1 opts into destructive pushes; the default keeps
# production boots conservative (a conflicting schema fails the push but the
# server still boots on the existing tables).
if [ "${DB_PUSH_ACCEPT_DATA_LOSS:-0}" = "1" ]; then
  bunx prisma db push --skip-generate --accept-data-loss || \
    echo "[entrypoint] ⚠ db push failed — booting on the existing schema"
else
  bunx prisma db push --skip-generate || \
    echo "[entrypoint] ⚠ db push failed — booting on the existing schema"
fi

echo "[entrypoint] starting BLACKHOLE Terminal on :${PORT:-3000}"
exec bun server.js
