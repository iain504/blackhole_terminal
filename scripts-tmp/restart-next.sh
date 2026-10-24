#!/bin/bash
# Canonical dev-server restart (Task 9-p) — the ONE routine everyone uses:
#   - ops-watchdog.sh (auto-heal)
#   - stream-service /ops/restart-next (browser-triggered restart)
# Detached double-fork spawn so the caller (a CGI-ish HTTP handler or the
# watchdog loop) never becomes the parent of the dev server.
cd /home/z/my-project || exit 1
echo "$(date -u +%FT%TZ) restart-next.sh: killing next, respawning dev server" >> scripts-tmp/restart.log
pkill -f 'next dev' 2>/dev/null
pkill -f 'next-server' 2>/dev/null
sleep 2
( NODE_OPTIONS=--max-old-space-size=1800 bun run dev >> dev.log 2>&1 & ) < /dev/null > /dev/null 2>&1
echo "$(date -u +%FT%TZ) restart-next.sh: dev server respawned (warming up)" >> scripts-tmp/restart.log
