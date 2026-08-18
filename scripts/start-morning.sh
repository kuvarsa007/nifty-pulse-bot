#!/bin/bash
# Starts the bot for the trading day with npm (NO Docker).
# Cron (recommended):
#   CRON_TZ=Asia/Kolkata
#   20 9 * * 1-5 APP_DIR=/home/new /bin/bash /home/new/scripts/start-morning.sh >> /home/new/logs/cron-wrap.log 2>&1

# Do not use `set -e` until after first log write — early exits were invisible to cron (no MTA).
set -uo pipefail

APP_DIR="${APP_DIR:-/home/new}"
LOG_DIR="$APP_DIR/logs"
mkdir -p "$LOG_DIR"

STAMP="$(date +%Y-%m-%d)"
CRON_LOG="$LOG_DIR/cron-$STAMP.log"
WRAP_LOG="$LOG_DIR/cron-wrap.log"

log() {
  local line="$*"
  echo "$line" >> "$CRON_LOG"
  echo "$line" >> "$WRAP_LOG"
}

log "========================================"
log "Morning start: $(date '+%Y-%m-%d %H:%M:%S %Z')"
log "APP_DIR=$APP_DIR"
log "pid=$$ whoami=$(whoami 2>/dev/null || echo unknown)"

# Cron has a tiny PATH — add normal system bins
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

# Load nvm if present (never abort — nvm can call exit in non-interactive shells)
export NVM_DIR="${NVM_DIR:-${HOME:-/root}/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1090
  set +u
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
  set -u
  log "nvm=loaded ($NVM_DIR)"
else
  log "nvm=skipped"
fi

cd "$APP_DIR" || {
  log "FATAL: cannot cd to APP_DIR=$APP_DIR"
  exit 1
}

log "mode=npm (no docker)"
log "PATH=$PATH"
log "pwd=$(pwd)"

NPM_BIN="$(command -v npm || true)"
NODE_BIN="$(command -v node || true)"

if [ -z "$NPM_BIN" ]; then
  log "FATAL: npm not found in PATH"
  log "PATH=$PATH"
  exit 1
fi

log "npm=$NPM_BIN"
log "node=${NODE_BIN:-missing}"
log "========================================"

# Stop leftover bot (npm/node only — not docker)
pkill -f "node dist/index.js" 2>/dev/null || true
pkill -f "tsx src/index.ts" 2>/dev/null || true

log "Starting: npm run dry-run:live"
set +e
"$NPM_BIN" run dry-run:live >> "$CRON_LOG" 2>&1
EXIT_CODE=$?
set -e

log "========================================"
log "Session ended: $(date '+%Y-%m-%d %H:%M:%S %Z') exit=$EXIT_CODE"
log "========================================"

exit "$EXIT_CODE"
