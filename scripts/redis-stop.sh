#!/usr/bin/env bash
# Stop the 3 logical Redis cache nodes.
PORTS=(6379 6380 6381)
for p in "${PORTS[@]}"; do
  if redis-cli -p "$p" shutdown nosave 2>/dev/null; then
    echo "stopped redis on $p"
  else
    echo "redis on $p not running"
  fi
done
