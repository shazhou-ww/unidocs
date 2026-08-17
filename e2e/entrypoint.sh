#!/bin/bash
set -e

cd /app/packages/markdown

# Start wrangler dev server in background
pnpm wrangler dev --local --port 8787 --ip 0.0.0.0 > /tmp/wrangler.log 2>&1 &
WRANGLER_PID=$!

# Wait for ready (accept any HTTP response — 404 on root is fine)
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8787/ 2>/dev/null || echo "000")
  if [ "$code" != "000" ]; then
    break
  fi
  sleep 1
done

if [ "$code" = "000" ]; then
  echo "wrangler failed to start within 60s" >&2
  cat /tmp/wrangler.log >&2
  exit 1
fi

# Keep container alive — wait on wrangler process
wait $WRANGLER_PID
