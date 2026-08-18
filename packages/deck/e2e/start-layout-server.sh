#!/usr/bin/env bash
# start-layout-server.sh - second E2E app server, on PORT=3918.
#
# Identical build, different roots: this one is given an ACTIVITY_ROOT, so it
# renders the top-bar escalation alert. The e2e/layout suite measures the
# header against it at real viewport widths.
#
# WHY A SECOND SERVER: activityEnabled() reads ACTIVITY_ROOT once, at boot, so
# the alert cannot be switched on for one test. Setting it on the main server
# would move every other suite onto the activity-configured branch, including
# tmux-tab.test.ts which asserts the not-configured branch by name. See the
# layout block in e2e/setup.mjs.
#
# BUILD ORDER: playwright starts both webServers at once, and only the first
# one's command runs `pnpm build`. This script therefore waits for the main
# server to answer on 3917 before starting - a server on 3917 cannot exist
# until that build has finished, so it is an exact, race-free signal (rather
# than sleeping, or testing build/ for a file that a previous run may have
# left behind).
#
# ASCII only - no em-dashes (FND-05).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$REPO_ROOT/e2e/.e2e-env"

WAIT=0
while [ ! -f "$ENV_FILE" ]; do
  sleep 0.2
  WAIT=$((WAIT + 1))
  if [ "$WAIT" -gt 50 ]; then
    echo "[start-layout-server.sh] ERROR: e2e/.e2e-env not found after 10s" >&2
    exit 1
  fi
done

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# Wait for the main server, i.e. for the shared build to exist.
WAIT=0
until curl -sf -o /dev/null "http://localhost:3917/"; do
  sleep 0.5
  WAIT=$((WAIT + 1))
  if [ "$WAIT" -gt 220 ]; then
    echo "[start-layout-server.sh] ERROR: main server never came up on 3917" >&2
    exit 1
  fi
done

# Map the LAYOUT_-prefixed roots onto the real names, for THIS process only.
export INBOX_ROOT="$LAYOUT_INBOX_ROOT"
export ATTACHMENTS_ROOT="$LAYOUT_ATTACHMENTS_ROOT"
export PROJECTS_ROOT="$LAYOUT_PROJECTS_ROOT"
export DATA_ROOT="$LAYOUT_DATA_ROOT"
export ACTIVITY_ROOT="$LAYOUT_ACTIVITY_ROOT"
export QUEUE_STATE_PATH="$LAYOUT_DATA_ROOT/queue-state.json"

echo "[start-layout-server.sh] ACTIVITY_ROOT=$ACTIVITY_ROOT"

cd "$REPO_ROOT"
export PORT=3918
exec pnpm start
