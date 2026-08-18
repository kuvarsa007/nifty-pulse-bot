/**
 * Telegram alerts for NiftyPulse bot.
 * Set TELEGRAM_ENABLED=true, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID in .env
 */

import https from 'https';

function enabled(): boolean {
  return process.env.TELEGRAM_ENABLED === 'true';
}

function token(): string {
  return (process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
}

function chatId(): string {
  return (process.env.TELEGRAM_CHAT_ID ?? '').trim();
}

/**
 * Fire-and-forget Telegram message. Never throws to callers.
 */
export async function sendTelegram(text: string): Promise<void> {
  if (!enabled()) return;

  const botToken = token();
  const chat = chatId();
  if (!botToken || !chat) {
    console.warn(
      `Telegram enabled but missing: ` +
        `${!botToken ? 'TELEGRAM_BOT_TOKEN ' : ''}` +
        `${!chat ? 'TELEGRAM_CHAT_ID' : ''}`.trim()
    );
    return;
  }

  const body = JSON.stringify({
    chat_id: chat,
    text: text.slice(0, 4000),
    disable_web_page_preview: true,
  });

  try {
    await postJson(`https://api.telegram.org/bot${botToken}/sendMessage`, body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Telegram send failed: ${message}`);
  }
}

export function notifyBotStart(data: Record<string, string | number | boolean>): void {
  const mode = String(data.mode ?? '');
  const watchlist = String(data.watchlist ?? '');
  void sendTelegram(
    `NiftyPulse started\n` +
      `Mode: ${mode}\n` +
      `Watchlist: ${watchlist}\n` +
      `Target: ${data.profitTarget} | SL: ${data.stopLoss}\n` +
      `Cap/trade: ${data.amountPerTrade}` +
      (data.buyPower ? ` | BuyPower: ${data.buyPower}` : '') +
      (data.intradayLeverage ? ` (${data.intradayLeverage})` : '')
  );
}

export function notifyBuy(
  kind: 'DRY_RUN' | 'LIVE',
  data: Record<string, string | number>
): void {
  void sendTelegram(
    `${kind === 'LIVE' ? 'LIVE BUY' : 'DRY BUY'} ${data.symbol}\n` +
      `Price: ${data.price} × ${data.quantity}\n` +
      `Value: ${data.value}` +
      (data.leverage ? ` | Lev: ${data.leverage}` : '') +
      `\n` +
      `Target: ${data.targetSell} | Stop: ${data.stopSell}`
  );
}

export function notifySell(
  kind: 'DRY_RUN' | 'LIVE',
  data: Record<string, string | number>
): void {
  void sendTelegram(
    `${kind === 'LIVE' ? 'LIVE SELL' : 'DRY SELL'} ${data.symbol}\n` +
      `Reason: ${data.reason}\n` +
      `Entry: ${data.entry} → Exit: ${data.exit}\n` +
      `PnL: ${data.pnl ?? ''}\n` +
      `Day: ${data.dayPnl ?? ''}`
  );
}

export function notifyDaySummary(data: Record<string, string | number>): void {
  void sendTelegram(
    `Day summary ${data.date}\n` +
      `Mode: ${data.mode}\n` +
      `Watchlist: ${data.watchlist}\n` +
      `Trades: ${data.totalTrades} (W${data.wins}/L${data.losses}) ${data.winRate}\n` +
      `Net PnL: ${data.netPnl}\n` +
      `Buy signals: ${data.buySignals}`
  );
}

export function notifyError(event: string, message: string, action: string): void {
  // Skip noisy API backoff spam — only high-signal errors
  if (event === 'API_ERROR') return;
  void sendTelegram(`Error [${event}]\n${message}\n${action}`);
}

export function notifyScannerWatchlist(symbols: string[]): void {
  void sendTelegram(`Scanner watchlist\n${symbols.join(', ')}`);
}

export function notifyScannerFail(message: string): void {
  void sendTelegram(`Scanner HARD FAIL\n${message}\nBot will not trade fixed watchlist.`);
}

function postJson(url: string, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 15_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
            return;
          }
          try {
            const json = JSON.parse(text) as { ok?: boolean; description?: string };
            if (json.ok === false) {
              reject(new Error(json.description ?? 'Telegram API ok=false'));
              return;
            }
          } catch {
            // ignore parse — some proxies
          }
          resolve();
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Telegram request timeout'));
    });
    req.write(body);
    req.end();
  });
}
