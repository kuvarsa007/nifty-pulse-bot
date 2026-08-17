import fs from 'fs';
import path from 'path';
import { formatIST, istDateKey } from './utils/time';
import {
  notifyBotStart,
  notifyBuy,
  notifyDaySummary,
  notifyError,
  notifySell,
} from './notify/telegram';

type LogLevel = 'INFO' | 'WARN' | 'ERROR';

export class BotLogger {
  private logDir: string;
  private currentDateKey = '';
  private filePath = '';

  constructor(logDir = path.join(process.cwd(), 'logs')) {
    this.logDir = logDir;
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  private ensureFile(at: Date): void {
    const key = istDateKey(at);
    if (key === this.currentDateKey) return;
    this.currentDateKey = key;
    this.filePath = path.join(this.logDir, `${key}.log`);
  }

  private write(at: Date, level: LogLevel, event: string, lines: string[]): void {
    this.ensureFile(at);
    const header = `[${formatIST(at)}] ${level}  ${event}`;
    const body = lines.map((l) => `  ${l}`).join('\n');
    const block = body ? `${header}\n${body}\n` : `${header}\n`;
    fs.appendFileSync(this.filePath, block, 'utf8');
    // writeSync so cron/nohup logs update immediately (stdout is buffered when not a TTY)
    try {
      fs.writeSync(1, block);
    } catch {
      process.stdout.write(block);
    }
  }

  botStart(at: Date, data: Record<string, string | number | boolean>): void {
    this.write(at, 'INFO', 'BOT_START', Object.entries(data).map(([k, v]) => `${k}: ${v}`));
    notifyBotStart(data);
  }

  marketWait(at: Date, reason: string, nextCheck: Date): void {
    this.write(at, 'INFO', 'MARKET_WAIT', [
      `reason: ${reason}`,
      `nextCheck: ${formatIST(nextCheck).replace(' IST', '')}`,
    ]);
  }

  analyze(at: Date, data: {
    symbol: string;
    candles: string;
    close: number;
    sma20: number;
    rsi14: number;
    volume: number;
    avgVolume10: number;
    signal: string;
    reasons: string[];
    openPosition: string;
    tradesToday: string;
    action: string;
  }): void {
    const lines = [
      `symbol: ${data.symbol}`,
      `candles: ${data.candles}`,
      `close: ₹${data.close.toFixed(2)}`,
      `sma20: ₹${data.sma20.toFixed(2)}`,
      `rsi14: ${data.rsi14.toFixed(1)}`,
      `volume: ${Math.round(data.volume)} (avg10: ${Math.round(data.avgVolume10)})`,
      `signal: ${data.signal}`,
      'reasons:',
      ...data.reasons.map((r) => `  - ${r}`),
      `openPosition: ${data.openPosition}`,
      `tradesToday: ${data.tradesToday}`,
      `action: ${data.action}`,
    ];
    this.write(at, 'INFO', 'ANALYZE', lines);
  }

  dryRunBuy(at: Date, data: Record<string, string | number>): void {
    this.write(at, 'INFO', 'DRY_RUN BUY', Object.entries(data).map(([k, v]) => `${k}: ${v}`));
    notifyBuy('DRY_RUN', data);
  }

  liveBuy(at: Date, data: Record<string, string | number>): void {
    this.write(at, 'INFO', 'LIVE BUY', Object.entries(data).map(([k, v]) => `${k}: ${v}`));
    notifyBuy('LIVE', data);
  }

  protectionArmed(at: Date, data: Record<string, string | number>): void {
    this.write(at, 'INFO', 'PROTECTION_ARMED', Object.entries(data).map(([k, v]) => `${k}: ${v}`));
  }

  trailingStopArmed(at: Date, data: Record<string, string | number>): void {
    this.write(at, 'INFO', 'TRAILING_STOP_ARMED', Object.entries(data).map(([k, v]) => `${k}: ${v}`));
  }

  positionMonitor(at: Date, data: Record<string, string | number>): void {
    this.write(at, 'INFO', 'POSITION_MONITOR', Object.entries(data).map(([k, v]) => `${k}: ${v}`));
  }

  dryRunSell(at: Date, data: Record<string, string | number>, level: LogLevel = 'INFO'): void {
    this.write(at, level, 'DRY_RUN SELL', Object.entries(data).map(([k, v]) => `${k}: ${v}`));
    notifySell('DRY_RUN', data);
  }

  liveSell(at: Date, data: Record<string, string | number>, level: LogLevel = 'INFO'): void {
    this.write(at, level, 'LIVE SELL', Object.entries(data).map(([k, v]) => `${k}: ${v}`));
    notifySell('LIVE', data);
  }

  cooldown(at: Date, reason: string, until: Date): void {
    this.write(at, 'INFO', 'COOLDOWN', [
      `reason: ${reason}`,
      `noNewBuyUntil: ${formatIST(until).replace(' IST', '')}`,
    ]);
  }

  botPause(at: Date, reason: string, resume: string): void {
    this.write(at, 'INFO', 'BOT_PAUSE', [`reason: ${reason}`, `resume: ${resume}`]);
  }

  botStop(at: Date, reason: string, noMoreTradesToday: boolean): void {
    this.write(at, 'WARN', 'BOT_STOP', [
      `reason: ${reason}`,
      `noMoreTradesToday: ${noMoreTradesToday}`,
    ]);
  }

  daySummary(at: Date, data: Record<string, string | number>): void {
    this.write(at, 'INFO', 'DAY_SUMMARY', Object.entries(data).map(([k, v]) => `${k}: ${v}`));
    notifyDaySummary(data);
  }

  error(at: Date, event: string, message: string, action: string): void {
    this.write(at, 'ERROR', event, [`message: ${message}`, `action: ${action}`]);
    notifyError(event, message, action);
  }

  getLogFilePath(): string {
    return this.filePath;
  }
}
