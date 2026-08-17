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

CRON_LINE="20 9 * * 1-5 APP_DIR=$APP_DIR $APP_DIR/scripts/start-morning.sh"
CRON_TMP="$(mktemp)"
crontab -l 2>/dev/null | grep -v 'start-morning.sh' > "$CRON_TMP" || true
echo "$CRON_LINE" >> "$CRON_TMP"
crontab "$CRON_TMP"
rm -f "$CRON_TMP"

echo ""
echo "==> Cron installed (Monâ€“Fri 09:20 IST):"
crontab -l | grep start-morning || true
echo ""
echo "Done. Bot will auto-start on trading mornings."
echo "Test now with:"
echo "  bash scripts/start-morning.sh"
echo ""
echo "Keep DRY_RUN / dry-run:live until you are ready for real money."
