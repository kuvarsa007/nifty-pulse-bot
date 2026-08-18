import dotenv from 'dotenv';
import { BotConfig, TradeType } from './types';

dotenv.config();

function envStr(key: string, fallback: string): string {
  return process.env[key]?.trim() || fallback;
}

function envNum(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key]?.toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function parseTradeType(value: string): TradeType {
  return value.toUpperCase() === 'DELIVERY' ? 'DELIVERY' : 'INTRADAY';
}

function parseWatchlist(watchlistRaw: string, fallbackSymbol: string): string[] {
  const fromEnv = watchlistRaw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (fromEnv.length > 0) return fromEnv;
  return [fallbackSymbol.toUpperCase()];
}

export function loadConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  const fallbackSymbol = overrides.symbol ?? envStr('SYMBOL', 'IDEA-EQ');
  const watchlist =
    overrides.watchlist ??
    parseWatchlist(envStr('WATCHLIST', ''), fallbackSymbol);

  return {
    dryRun: overrides.dryRun ?? envBool('DRY_RUN', true),
    symbol: watchlist[0],
    watchlist,
    exchange: overrides.exchange ?? envStr('EXCHANGE', 'NSE'),
    tradeType: overrides.tradeType ?? parseTradeType(envStr('TRADE_TYPE', 'INTRADAY')),
    maxTradesPerDay: overrides.maxTradesPerDay ?? envNum('MAX_TRADES_PER_DAY', 5),
    maxOpenPositions: overrides.maxOpenPositions ?? envNum('MAX_OPEN_POSITIONS', 2),
    amountPerTrade: overrides.amountPerTrade ?? envNum('AMOUNT_PER_TRADE', 5000),
    intradayLeverage: overrides.intradayLeverage ?? envNum('INTRADAY_LEVERAGE', 5),
    profitTargetPct: overrides.profitTargetPct ?? envNum('PROFIT_TARGET_PCT', 1),
    stopLossPct: overrides.stopLossPct ?? envNum('STOP_LOSS_PCT', 2),
    dailyLossCap: overrides.dailyLossCap ?? envNum('DAILY_LOSS_CAP', 150),
    cooldownAfterStopMin: overrides.cooldownAfterStopMin ?? envNum('COOLDOWN_AFTER_STOP_MIN', 30),
    candleCount: overrides.candleCount ?? envNum('CANDLE_COUNT', 50),
    analyzeEverySec: overrides.analyzeEverySec ?? envNum('ANALYZE_EVERY_SEC', 300),
    analyzeRotateSec: overrides.analyzeRotateSec ?? envNum('ANALYZE_ROTATE_SEC', 45),
    monitorEverySec: overrides.monitorEverySec ?? envNum('MONITOR_EVERY_SEC', 60),
    apiErrorBackoffSec: overrides.apiErrorBackoffSec ?? envNum('API_ERROR_BACKOFF_SEC', 45),
    candleRefreshSec: overrides.candleRefreshSec ?? envNum('CANDLE_REFRESH_SEC', 1800),
    noBuyAfterHour: overrides.noBuyAfterHour ?? envNum('NO_BUY_AFTER_HOUR', 14),
    noBuyAfterMinute: overrides.noBuyAfterMinute ?? envNum('NO_BUY_AFTER_MIN', 30),
    minQuantity: overrides.minQuantity ?? envNum('MIN_QUANTITY', 2),
    smaMinMarginPct: overrides.smaMinMarginPct ?? envNum('SMA_MIN_MARGIN_PCT', 0.15),
    volumeSpikeMult: overrides.volumeSpikeMult ?? envNum('VOLUME_SPIKE_MULT', 1.2),
    trailingArmPct: overrides.trailingArmPct ?? envNum('TRAILING_ARM_PCT', 0.8),
    trailingLockPct: overrides.trailingLockPct ?? envNum('TRAILING_LOCK_PCT', 0.5),
    trend15MinCount: overrides.trend15MinCount ?? envNum('TREND_15MIN_COUNT', 20),
    resistanceMarginPct: overrides.resistanceMarginPct ?? envNum('RESISTANCE_MARGIN_PCT', 0.5),
    useIndexFilter: overrides.useIndexFilter ?? envBool('USE_INDEX_FILTER', true),
    indexSymbol: overrides.indexSymbol ?? envStr('INDEX_SYMBOL', 'NIFTYBEES-EQ'),
    useMockData: overrides.useMockData ?? envBool('USE_MOCK_DATA', false),
  };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function formatRupeeSigned(n: number): string {
  const sign = n >= 0 ? '+' : '-';
  return `${sign}₹${round2(Math.abs(n)).toFixed(2)}`;
}

export function formatRupee(n: number): string {
  return `₹${round2(n).toFixed(2)}`;
}

/**
 * Effective buying power for qty sizing.
 * INTRADAY: amountPerTrade × intradayLeverage (matches Angel One ~5x margin).
 * DELIVERY: amountPerTrade only (1x).
 */
export function getBuyPower(config: Pick<BotConfig, 'amountPerTrade' | 'intradayLeverage' | 'tradeType'>): number {
  const leverage =
    config.tradeType === 'INTRADAY' ? Math.max(1, config.intradayLeverage) : 1;
  return round2(config.amountPerTrade * leverage);
}

export function displaySymbol(symbol: string): string {
  return symbol.replace('-EQ', '');
}
