#!/bin/sh
# BLACKHOLE Terminal — Docker build-cache cleanup (v2.9.0).
#
# Why: every `docker compose up -d --build` leaves BuildKit layer cache
# behind. It accumulates FOREVER — 15.48 GB was observed on a host that only
# ever rebuilt this app (active images: 3.7 GB, db volume: 39 MB). Build
# cache is the single biggest "where did my disk go" item on a rebuild-heavy
# host, and `docker system prune` alone does NOT touch it (use -a or this).
#
# What this does: prunes BUILD CACHE ONLY — keeps all images, containers and
# volumes. Run it after every build (or wire it into your deploy alias).
#
#   Usage:  scripts/docker-clean-cache.sh            # keep last 2 GB of cache
#           scripts/docker-clean-cache.sh full        # drop all build cache
#
# Automatic option (no script): set a GC policy in /etc/docker/daemon.json —
#   { "builder": { "gc": { "defaultKeepStorage": "2GB", "enabled": true } } }
# then `systemctl restart docker` (Docker Desktop: Settings → Docker Engine).
set -e

if [ "${1:-}" = "full" ]; then
  echo "[docker-clean] pruning ALL build cache (images/containers/volumes are kept)…"
  docker builder prune -f --all
else
  echo "[docker-clean] pruning build cache, keeping the newest 2 GB…"
  docker builder prune -f --keep-storage=2gb
fi

echo "[docker-clean] done. Disk usage now:"
docker system df
