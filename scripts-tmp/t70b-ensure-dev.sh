#!/bin/bash
# Task 70b — ensure the dev server is up (the sandbox reaps background
# processes between tool calls and the original server was OOM-killed).
# Usage: bash scripts-tmp/t70b-ensure-dev.sh
for i in 1 2 3; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://localhost:3000/ 2>/dev/null)
  if [ "$code" = "200" ] || [ "$code" = "307" ] || [ "$code" = "302" ]; then
    exit 0
  fi
  cd /home/z/my-project
  setsid bash -c 'exec bun run dev >> dev.log 2>&1' < /dev/null > /dev/null 2>&1 &
  for w in $(seq 1 40); do
    sleep 1
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://localhost:3000/ 2>/dev/null)
    if [ "$code" = "200" ] || [ "$code" = "307" ] || [ "$code" = "302" ]; then
      curl -s -o /dev/null --max-time 60 http://localhost:3000/ # warm-compile
      exit 0
    fi
  done
done
echo "DEV SERVER FAILED TO START" >&2
exit 1
