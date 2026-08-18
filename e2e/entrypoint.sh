#!/bin/bash
set -e

# Copy source from read-only mount (/app) to writable workspace
# Dependencies are pre-installed in /opt/deps (not affected by /app mount)
echo "Setting up workspace..."
mkdir -p /workspace
cd /workspace

# Copy source files from mount
cp -r /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/package.json /app/tsconfig.json .
cp -r /app/packages .
cp -r /app/e2e . 2>/dev/null || true

# Symlink pre-installed node_modules from /opt/deps
ln -s /opt/deps/node_modules node_modules
for pkg in packages/*/; do
  pkg_name=$(basename "$pkg")
  if [ -d "/opt/deps/packages/$pkg_name/node_modules" ]; then
    ln -s "/opt/deps/packages/$pkg_name/node_modules" "$pkg/node_modules"
  fi
done

# Build packages (TypeScript → dist/)
echo "Building packages..."
pnpm -r build

cd packages/markdown

# Start wrangler dev server in background
echo "Starting wrangler dev server..."
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

echo "wrangler ready"

# Keep container alive — wait on wrangler process
wait $WRANGLER_PID
