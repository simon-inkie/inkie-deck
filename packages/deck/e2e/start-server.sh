#!/usr/bin/env bash
# start-server.sh - E2E test server launcher.
#
# Sources e2e/.e2e-env (written by node e2e/setup.mjs before playwright starts)
# and then starts the React Router server on PORT=3917.
#
# Called by playwright.config.ts webServer command AFTER pnpm build succeeds.
# The env file is guaranteed to exist because pnpm e2e runs setup.mjs first.
#
# Waits briefly (up to 10s) in case of any race, then proceeds.
#
# ASCII only - no em-dashes.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$REPO_ROOT/e2e/.e2e-env"

# Wait up to 10s for env file (setup.mjs should have already written it).
WAIT=0
while [ ! -f "$ENV_FILE" ]; do
  sleep 0.2
  WAIT=$((WAIT + 1))
  if [ $WAIT -gt 50 ]; then
    echo "[start-server.sh] ERROR: e2e/.e2e-env not found after 10s" >&2
    echo "[start-server.sh] Run: node e2e/setup.mjs before calling playwright" >&2
    exit 1
  fi
done

# Source the env file to get INBOX_ROOT, QUEUE_STATE_PATH, MC_NOW, MC_SANDBOX_ONLY.
set -a
source "$ENV_FILE"
set +a

echo "[start-server.sh] INBOX_ROOT=$INBOX_ROOT"

# Start the server.
cd "$REPO_ROOT"
export PORT=3917
exec pnpm start
