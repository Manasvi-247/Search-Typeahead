#!/usr/bin/env bash
# Start 3 logical Redis cache nodes on ports 6379/6380/6381.
# Persistence is disabled (--save "" --appendonly no): this is a CACHE, the durable data
# lives in SQLite. A node crash just causes cache misses, never data loss (doc1:305-308).
set -euo pipefail
PORTS=(6379 6380 6381)
for p in "${PORTS[@]}"; do
  if redis-cli -p "$p" ping >/dev/null 2>&1; then
    echo "redis on $p already running"
  else
    redis-server --port "$p" --daemonize yes --save "" --appendonly no \
      --pidfile "/tmp/redis-$p.pid" --logfile "/tmp/redis-$p.log"
    echo "started redis on $p"
  fi
done
