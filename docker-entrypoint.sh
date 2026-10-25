#!/bin/sh
# BLACKHOLE Terminal container entrypoint (Task 11-d, hardened in Task 13).
# 1. resolve + validate the SQLite directory — if the configured path is not
#    usable inside the container (e.g. a host path like
#    file:/home/z/my-project/db/custom.db pasted into a Render env var,
#    which makes Prisma fail with "Error code 14: Unable to open the
#    database file"), fall back to the writable default /app/db
# 2. apply the Prisma schema (db push) — safe to run on every boot
# 3. prove the database file exists, then exec the standalone Next.js server
set -e

: "${DATABASE_URL:=file:/app/db/custom.db}"

# ---- resolve the sqlite file path out of DATABASE_URL ----------------------
db_path="$DATABASE_URL"
case "$db_path" in
  file:*) db_path="${db_path#file:}" ;;
esac
db_path="${db_path%%\?*}"                 # strip ?connection_limit=… params
case "$db_path" in
  /*) ;;    # absolute — keep as-is
  *)  db_path="/app/${db_path#./}"    # relative → resolve against /app
      # rewrite DATABASE_URL too, otherwise prisma resolves the relative
      # path against prisma/ (the schema dir), not the validated location
      DATABASE_URL="file:$db_path"
      export DATABASE_URL ;;
esac
db_dir="$(dirname "$db_path")"

# ---- the directory must be creatable AND writable, else self-heal ----------
if ! mkdir -p "$db_dir" 2>/dev/null || ! touch "$db_dir/.bh-write-test" 2>/dev/null; then
  echo "[entrypoint] ⚠ DATABASE_URL directory '$db_dir' is not writable in this container."
  echo "[entrypoint]   falling back to file:/app/db/custom.db"
  echo "[entrypoint]   (on Render, DATABASE_URL must live under /app — e.g. file:/app/db/custom.db —"
  echo '[entrypoint]    or simply delete the env var; the image default is identical)'
  DATABASE_URL="file:/app/db/custom.db"
  export DATABASE_URL
  db_path="/app/db/custom.db"
  db_dir="/app/db"
  mkdir -p "$db_dir" 2>/dev/null || \
    echo "[entrypoint] ⚠ cannot create $db_dir either — the db push below will surface the real error"
fi
rm -f "$db_dir/.bh-write-test" 2>/dev/null || true

if [ -f "$db_path" ] && [ ! -w "$db_path" ]; then
  echo "[entrypoint] ⚠ $db_path exists but is not writable — SQLite will fail to open it."
fi

echo "[entrypoint] DATABASE_URL=$DATABASE_URL"

# ---- fresh-database hint (ephemeral Render disk = fresh on every deploy) ---
if [ ! -f "$db_path" ]; then
  echo "[entrypoint] fresh database — create your account via the UI after boot"
  echo "[entrypoint] (ALLOW_REGISTRATION=${ALLOW_REGISTRATION:-unset})"
fi

echo "[entrypoint] applying prisma schema…"
# DB_PUSH_ACCEPT_DATA_LOSS=1 opts into destructive pushes; the default keeps
# production boots conservative (a conflicting schema fails the push but the
# server still boots on the existing tables).
if [ "${DB_PUSH_ACCEPT_DATA_LOSS:-0}" = "1" ]; then
  bunx prisma db push --skip-generate --accept-data-loss || \
    echo "[entrypoint] ⚠ db push FAILED — the server will boot, but DB queries will error"
else
  bunx prisma db push --skip-generate || \
    echo "[entrypoint] ⚠ db push FAILED — the server will boot, but DB queries will error"
fi

# ---- prove the database is really there before handing off to the server ---
if [ -f "$db_path" ]; then
  echo "[entrypoint] database ready: $db_path ($(wc -c < "$db_path") bytes)"
else
  echo "[entrypoint] ⚠ expected database file $db_path was NOT created — check the push output above"
fi

echo "[entrypoint] starting BLACKHOLE Terminal on :${PORT:-3000}"
exec bun server.js
