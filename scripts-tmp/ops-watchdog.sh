#!/bin/bash
# Ops watchdog (Task 9-b, 10/10 program) — keeps the dev server alive inside the
# 4GB/no-swap sandbox. Two failure modes handled:
#   1) server down (sandbox reaped it / crash)            -> restart via the
#      surviving double-fork launch pattern (Task 8 finding)
#   2) next-server RSS > limit, sustained 2 checks        -> pre-emptive restart
#      BEFORE the kernel OOM-killer takes the whole box (observed deaths at
#      ~2.2GB RSS with stream-service + gateway co-resident).
# The restart exports NODE_OPTIONS=--max-old-space-size=1800 so a runaway sweep
# degrades into ONE failed request (catchable RangeError -> route 500) instead
# of a kernel OOM that kills the server.
# Single instance guarded by pidfile. Run detached with the double-fork pattern:
#   ( bash scripts-tmp/ops-watchdog.sh < /dev/null >> scripts-tmp/watchdog.log 2>&1 & )
PIDFILE=/tmp/bh-watchdog.pid
RSS_LIMIT_KB=2300000
CHECK_EVERY=60
LOG=scripts-tmp/watchdog.log

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  exit 0  # already running
fi
echo $$ > "$PIDFILE"

cd /home/z/my-project || exit 1
fail_count=0
rss_count=0

probe() {
  local c
  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:3000/ 2>/dev/null)
  [ "$c" = "200" ] || [ "$c" = "307" ] || [ "$c" = "302" ]
}

restart_dev() {
  echo "$(date -u +%FT%TZ) watchdog: restarting dev server ($1)" >> "$LOG"
  pkill -f 'next dev' 2>/dev/null
  pkill -f 'next-server' 2>/dev/null
  sleep 2
  ( NODE_OPTIONS=--max-old-space-size=1800 bun run dev >> dev.log 2>&1 & ) < /dev/null > /dev/null 2>&1
  for w in $(seq 1 90); do
    sleep 1
    if probe; then
      curl -s -o /dev/null --max-time 90 http://localhost:3000/ # warm-compile
      echo "$(date -u +%FT%TZ) watchdog: dev server back up" >> "$LOG"
      return 0
    fi
  done
  echo "$(date -u +%FT%TZ) watchdog: dev server FAILED to come back" >> "$LOG"
  return 1
}

while true; do
  sleep "$CHECK_EVERY"

  if probe; then
    fail_count=0
  else
    fail_count=$((fail_count + 1))
  fi

  rss=$(ps -eo rss,args | awk '/next-server/ && !/awk/ {print $1; exit}')
  if [ -n "$rss" ] && [ "$rss" -gt "$RSS_LIMIT_KB" ] 2>/dev/null; then
    rss_count=$((rss_count + 1))
  else
    rss_count=0
  fi

  if [ "$fail_count" -ge 2 ]; then
    restart_dev "down x$fail_count"
    fail_count=0; rss_count=0
  elif [ "$rss_count" -ge 2 ]; then
    restart_dev "RSS ${rss}KB > ${RSS_LIMIT_KB}KB sustained"
    fail_count=0; rss_count=0
  fi
done
