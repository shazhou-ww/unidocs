#!/bin/bash
set -e

cd /app/packages/markdown

# Start wrangler dev server in background
pnpm wrangler dev --local --port 8787 --ip 0.0.0.0 > /tmp/wrangler.log 2>&1 &

# Wait for ready (accept 404 — root path has no route, but server is up)
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8787/ 2>/dev/null || echo "000")
  if [ "$code" != "000" ]; then
    exit 0
  fi
  sleep 1
done

echo "wrangler failed to start within 60s" >&2
cat /tmp/wrangler.log >&2
exit 1
