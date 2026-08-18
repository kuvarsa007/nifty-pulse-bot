#!/usr/bin/env bash
# One-time setup on a DigitalOcean Ubuntu droplet.
# Run from the project folder:
#   bash scripts/setup-droplet.sh

set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

echo "==> Setting timezone to Asia/Kolkata (IST)"
sudo timedatectl set-timezone Asia/Kolkata || true
date

echo "==> Checking Node.js"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Installing Node 20 via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v
npm -v

echo "==> Installing npm dependencies"
npm install

echo "==> Building TypeScript"
npm run build

echo "==> Making start script executable"
chmod +x scripts/start-morning.sh

if [ ! -f .env ]; then
  echo ""
  echo "WARNING: .env is missing."
  echo "Copy your local .env to the server, e.g.:"
  echo "  scp .env root@YOUR_DROPLET_IP:$APP_DIR/.env"
  echo ""
fi

# Strip Windows CRLF if the script was copied from a PC
sed -i 's/\r$//' scripts/start-morning.sh 2>/dev/null || true

# Keep IST even if the system clock drifts back to UTC.
# Always invoke via /bin/bash and capture stderr (cron has no mailer).
mkdir -p "$APP_DIR/logs"
CRON_TMP="$(mktemp)"
{
  echo "CRON_TZ=Asia/Kolkata"
  crontab -l 2>/dev/null | grep -v 'start-morning.sh' | grep -v '^CRON_TZ=' || true
  echo "20 9 * * 1-5 APP_DIR=$APP_DIR /bin/bash $APP_DIR/scripts/start-morning.sh >> $APP_DIR/logs/cron-wrap.log 2>&1"
} > "$CRON_TMP"
crontab "$CRON_TMP"
rm -f "$CRON_TMP"

echo ""
echo "==> Cron installed (Mon–Fri 09:20 IST):"
crontab -l | grep -E 'CRON_TZ|start-morning' || true
echo ""
echo "Done. Bot will auto-start on trading mornings."
echo "Test now with:"
echo "  APP_DIR=$APP_DIR /bin/bash scripts/start-morning.sh"
echo ""
echo "Keep DRY_RUN / dry-run:live until you are ready for real money."
