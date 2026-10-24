#!/bin/bash
# Crash-resilient wrapper: bun --hot handles file changes, this loop handles
# crashes (fail-closed exit on missing AUTH_SECRET exits deliberately — the
# loop would spin; the sleep keeps it from hot-looping and the error visible).
cd "$(dirname "$0")"
while true; do
  bun --hot index.ts
  code=$?
  echo "[run.sh] stream-service exited ($code) — restarting in 3s"
  sleep 3
done
