#!/usr/bin/env bash
# Starts the bot for the trading day with npm (NO Docker).
# Cron: 20 9 * * 1-5 APP_DIR=/home/new /home/new/scripts/start-morning.sh

set -euo pipefail

APP_DIR="${APP_DIR:-/home/new}"
LOG_DIR="$APP_DIR/logs"
mkdir -p "$LOG_DIR"

# Cron has a tiny PATH - add normal system bins
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

# Load nvm if present
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
fi

cd "$APP_DIR" || {
  echo "FATAL: cannot cd to APP_DIR=$APP_DIR" >&2
  exit 1
}

STAMP="$(date +%Y-%m-%d)"
CRON_LOG="$LOG_DIR/cron-$STAMP.log"

{
  echo "========================================"
  echo "Morning start: $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "APP_DIR=$APP_DIR"
  echo "mode=npm (no docker)"
  echo "whoami=$(whoami)"
  echo "PATH=$PATH"
} >> "$CRON_LOG"

NPM_BIN="$(command -v npm || true)"
NODE_BIN="$(command -v node || true)"

if [ -z "$NPM_BIN" ]; then
  echo "FATAL: npm not found in PATH" >> "$CRON_LOG"
  echo "PATH=$PATH" >> "$CRON_LOG"
  exit 1
fi

{
  echo "npm=$NPM_BIN"
  echo "node=${NODE_BIN:-missing}"
  echo "========================================"
} >> "$CRON_LOG"

# Stop leftover bot (npm/node only — not docker)
pkill -f "node dist/index.js" 2>/dev/null || true
pkill -f "tsx src/index.ts" 2>/dev/null || true

echo "Starting: npm run dry-run:live" >> "$CRON_LOG"
"$NPM_BIN" run dry-run:live >> "$CRON_LOG" 2>&1
EXIT_CODE=$?

{
  echo "========================================"
  echo "Session ended: $(date '+%Y-%m-%d %H:%M:%S %Z') exit=$EXIT_CODE"
  echo "========================================"
} >> "$CRON_LOG"

exit "$EXIT_CODE"
