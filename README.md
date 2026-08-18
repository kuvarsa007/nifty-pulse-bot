# NiftyPulse — Angel One Intraday Trading Bot

Node.js / TypeScript bot that scans liquid NSE stocks each morning, applies technical filters, and places **intraday** trades via **Angel One SmartAPI**.

Default mode is **dry-run** (live prices, simulated orders). Telegram alerts optional. Designed to run on a DigitalOcean VPS with cron at **09:20 IST** Mon–Fri.

---

## What it does

1. **Morning scanner** — finds liquid NSE movers (not a fixed stock list).
2. **Analysis** — RSI, SMA, volume, 15‑min trend, resistance checks on 5‑min candles.
3. **Risk sizing** — qty from margin buy power (`AMOUNT_PER_TRADE × INTRADAY_LEVERAGE`, default 5x like Angel One app).
4. **Entries** — dry-run logs buys, or live places ROBO bracket orders.
5. **Exits** — profit target, stop loss, trailing stop, or intraday square-off (~15:15).
6. **Guards** — no new buys after 14:00, daily loss cap, cooldown after stops, max open positions / trades per day.

---

## Project layout

```text
tredingapp/
├── src/
│   ├── index.ts              # Entry: mock / live-dry-run / live
│   ├── config.ts             # .env → BotConfig + getBuyPower()
│   ├── types.ts
│   ├── logger.ts             # Daily JSON logs under logs/
│   ├── bot/
│   │   ├── engine.ts         # Main loop: analyze → buy → monitor → sell
│   │   ├── analyzer.ts       # BUY filters (RSI/SMA/volume/trend/resistance)
│   │   └── risk.ts           # Qty, stops, trailing, daily loss
│   ├── market/
│   │   ├── angelOne.ts       # Market data + orders
│   │   ├── angelOneClient.ts # SmartAPI login / REST
│   │   ├── angelOneWebSocket.ts
│   │   └── mockReplay.ts     # Offline mock day
│   ├── scanner/
│   │   ├── marketScanner.ts  # Top movers from liquid universe
│   │   ├── liquidUniverse.ts
│   │   ├── instrumentMaster.ts
│   │   ├── runScan.ts
│   │   └── run.ts            # CLI: npm run scan
│   ├── notify/telegram.ts    # Telegram alerts
│   ├── backtest/run.ts       # Historical strategy test
│   └── utils/time.ts         # IST market hours helpers
├── scripts/
│   ├── start-morning.sh      # Cron entry (npm dry-run:live)
│   └── setup-droplet.sh      # VPS timezone + cron install
├── logs/                     # cron-YYYY-MM-DD.log + YYYY-MM-DD.log
├── .env                      # Secrets (never commit)
└── .env.example
```

---

## Requirements

- Node.js 20+
- Angel One SmartAPI app (API key, client id, password, TOTP secret)
- Server **static public IP** registered in Angel One (for live orders)
- Optional: Telegram bot token + chat id

---

## Quick start (local)

```bash
cp .env.example .env
# Fill Angel One + optional Telegram fields

npm install
npm run build

# Offline mock (no API)
npm run dry-run

# Live prices, fake orders (recommended while testing)
npm run dry-run:live

# Real money — only when ready
npm run live
```

---

## Run modes

| Command | Prices | Orders |
|---------|--------|--------|
| `npm run dry-run` / `--mock-day` | Mock replay | Simulated |
| `npm run dry-run:live` / `--live-dry-run` | Live Angel One + WS | Simulated |
| `npm run live` / `--live` | Live | **Real** ROBO / SL orders |

Also:

| Command | Purpose |
|---------|---------|
| `npm run scan` | Run scanner only |
| `npm run backtest` / `backtest:7` / `backtest:14` | Backtest last N days |
| `npm run telegram:test` | Send a test Telegram message |

---

## Strategy (buy filters)

All of these must pass on **closed** 5‑min candles (plus 15‑min trend):

1. **15‑min trend** — close above 15‑min SMA20  
2. **5‑min SMA** — close at least `SMA_MIN_MARGIN_PCT` above SMA20  
3. **RSI(14)** — between 40 and 65  
4. **Volume spike** — last volume ≥ `VOLUME_SPIKE_MULT` × 10‑bar average  
5. **Momentum** — RSI rising + green last candle  
6. **Resistance** — not within `RESISTANCE_MARGIN_PCT` of recent 20‑bar high  

### Exits

| Exit | Rule |
|------|------|
| Target | `+PROFIT_TARGET_PCT` from entry |
| Stop | `-STOP_LOSS_PCT` from entry |
| Trailing | Arms at `+TRAILING_ARM_PCT`, locks stop at `+TRAILING_LOCK_PCT` |
| Square-off | Intraday forced exit near market close |
| No new buys | After `NO_BUY_AFTER_HOUR:NO_BUY_AFTER_MIN` (default 14:00) |

### Position sizing

```text
buyPower = AMOUNT_PER_TRADE × INTRADAY_LEVERAGE   # INTRADAY only (default 5x)
quantity = floor(buyPower / price)
```

Delivery mode uses 1x. Tune `INTRADAY_LEVERAGE` so dry-run qty matches the Angel One app.

---

## Market scanner

When `SCANNER_ENABLED=true` (default):

- Scans a **liquid NSE universe** (not only `.env` WATCHLIST).
- Picks top movers by gain % / volume (quote mode FULL + `tradeVolume`).
- Can wait until **09:35** if the first pass is empty (`SCANNER_WAIT_935`).
- If scanner finds nothing and `SCANNER_ALLOW_ENV_FALLBACK=false` → **hard fail** (no silent fallback to IDEA/ITC/etc.).

Set `SCANNER_ALLOW_ENV_FALLBACK=true` only if you intentionally want the fixed `.env` watchlist.

---

## Environment variables

Copy `.env.example` → `.env`. Important keys:

### Trading / risk

| Variable | Meaning | Typical |
|----------|---------|---------|
| `DRY_RUN` | Simulate orders | `true` until ready |
| `TRADE_TYPE` | `INTRADAY` or `DELIVERY` | `INTRADAY` |
| `AMOUNT_PER_TRADE` | Margin capital per trade (₹) | `5000` |
| `INTRADAY_LEVERAGE` | Margin multiplier | `5` |
| `MIN_QUANTITY` | Skip if qty below this | `2` |
| `MAX_OPEN_POSITIONS` | Concurrent positions | `2` |
| `MAX_TRADES_PER_DAY` | Cap entries per day | `4` |
| `PROFIT_TARGET_PCT` | Target % | `1`–`1.2` |
| `STOP_LOSS_PCT` | Stop % | `2` |
| `TRAILING_ARM_PCT` / `TRAILING_LOCK_PCT` | Trailing stop | `0.8` / `0.5` |
| `DAILY_LOSS_CAP` | Stop trading after ₹ loss | `150` |
| `NO_BUY_AFTER_HOUR` | Cutoff for new buys | `14` |

### Angel One

| Variable | Meaning |
|----------|---------|
| `ANGEL_API_KEY` | SmartAPI key |
| `ANGEL_CLIENT_ID` | Client code |
| `ANGEL_PASSWORD` | PIN / password |
| `ANGEL_TOTP_SECRET` | Authenticator secret (for OTP) |
| `ANGEL_PUBLIC_IP` | Droplet public IP (must match Angel One whitelist) |

### Scanner

| Variable | Meaning |
|----------|---------|
| `SCANNER_ENABLED` | Run morning scan | `true` |
| `SCANNER_ALLOW_ENV_FALLBACK` | Use WATCHLIST if scan fails | `false` |
| `SCANNER_MIN_GAIN_PCT` | Min % from open | `0.15` |
| `SCANNER_MIN_VOLUME` | Min volume filter | `10000` |
| `SCANNER_MIN_PRICE` / `SCANNER_MAX_PRICE` | Price band | |

### Telegram

| Variable | Meaning |
|----------|---------|
| `TELEGRAM_ENABLED` | On/off |
| `TELEGRAM_BOT_TOKEN` | From BotFather |
| `TELEGRAM_CHAT_ID` | Your chat id |

**Never commit `.env`.** Rotate any token that was pasted in chat.

---

## Logs

Two files per day under `logs/`:

| File | Contents |
|------|----------|
| `cron-YYYY-MM-DD.log` | Shell/cron stdout (start script + npm output) |
| `YYYY-MM-DD.log` | Structured bot events (BOT_START, BUY, SELL, ANALYZE, …) |
| `cron-wrap.log` | Cron stderr/stdout capture (if crontab redirects here) |

Useful:

```bash
tail -f /home/new/logs/cron-$(date +%Y-%m-%d).log
grep -E "BUY|SELL|BOT_START|buyPower|leverage" /home/new/logs/$(date +%Y-%m-%d).log
```

---

## DigitalOcean / VPS deploy

App path on the droplet: **`/home/new`**.

### One-time

```bash
cd /home/new
cp .env.example .env   # then fill secrets
npm install
npm run build
chmod +x scripts/start-morning.sh
sed -i 's/\r$//' scripts/start-morning.sh   # kill Windows CRLF if copied from PC
bash scripts/setup-droplet.sh               # sets IST + cron
```

Or set cron by hand:

```cron
CRON_TZ=Asia/Kolkata
20 9 * * 1-5 APP_DIR=/home/new /bin/bash /home/new/scripts/start-morning.sh >> /home/new/logs/cron-wrap.log 2>&1
```

- **Timezone must be IST** (`Asia/Kolkata`) or use `CRON_TZ=Asia/Kolkata`.
- Always call with **`/bin/bash`** and redirect to `cron-wrap.log` (cron has no mailer — errors otherwise vanish).
- Strip `\r` from shell scripts after copying from Windows.

### Manual start today

```bash
APP_DIR=/home/new /bin/bash /home/new/scripts/start-morning.sh
```

### Verify cron fired

```bash
date
crontab -l
grep start-morning /var/log/syslog | tail -5
ls -la /home/new/logs/cron-$(date +%Y-%m-%d).log
```

If syslog shows `CMD (...start-morning.sh)` at 09:20 but **no log file**, the script crashed in &lt;1s (CRLF / npm PATH / nvm). Check `cron-wrap.log` or run with `bash -x`.

---

## Going live (real money checklist)

1. Dry-run qty matches Angel One app for the same stock (`INTRADAY_LEVERAGE`).
2. Static IP whitelisted in Angel One.
3. `DRY_RUN=true` proven for several sessions (Telegram + logs OK).
4. Understand brokerage (small % wins can be eaten by fees).
5. Only then: `DRY_RUN=false` and `npm run live` (or change start script accordingly).

---


## Disclaimer

This is **educational / personal automation**. Markets are risky. Past dry-run or backtest results do not guarantee live profit. You are responsible for API keys, orders, and compliance with Angel One / exchange rules.

---

## License

MIT
