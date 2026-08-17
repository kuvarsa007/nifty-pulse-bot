/**
 * Backtesting script — tests your trading strategy against historical Angel One data.
 *
 * Usage:
 *   npm run backtest           → last 30 days
 *   npm run backtest -- 14     → last 14 days
 *   npm run backtest -- 7      → last 7 days
 */

import { analyze15MinTrend, analyzeCandles } from '../bot/analyzer';
import { displaySymbol, formatRupee, formatRupeeSigned, loadConfig, round2 } from '../config';
import { AngelOneClient, loadAngelCredentials } from '../market/angelOneClient';
import { BotConfig, Candle } from '../types';
import { formatIST, isBuyWindowOpen, istDateKey, toIST } from '../utils/time';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TradeResult {
  symbol: string;
  date: string;
  entryTime: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;
  pnlPct: number;
  reason: 'TARGET' | 'STOP_LOSS' | 'SQUARE_OFF';
  durationMin: number;
}

interface FilterStats {
  trend15Blocked: number;
  resistanceBlocked: number;
  rsiBlocked: number;
  volumeBlocked: number;
  smaBlocked: number;
  momentumBlocked: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Group a flat candle list into a map keyed by IST date string. */
function groupByDay(candles: Candle[]): Map<string, Candle[]> {
  const map = new Map<string, Candle[]>();
  for (const c of candles) {
    const key = istDateKey(c.time);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(c);
  }
  return map;
}

function isSquareOffTime(at: Date): boolean {
  const ist = toIST(at);
  const min = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return min >= 15 * 60 + 15; // 3:15 PM IST
}

function pad(s: string | number, w: number): string {
  return String(s).padEnd(w);
}

function rpad(s: string | number, w: number): string {
  return String(s).padStart(w);
}

function separator(char = '─', len = 68): string {
  return char.repeat(len);
}

// ---------------------------------------------------------------------------
// Single-day simulation
// ---------------------------------------------------------------------------

function simulateDay(
  dateKey: string,
  symbol: string,
  candles5: Candle[],         // all 5-min bars for this day, sorted ascending
  allCandles15: Candle[],     // 15-min bars across all days (filtered by time inside)
  indexCandles15: Candle[],   // Nifty ETF 15-min candles for index filter
  config: BotConfig,
  filterStats: FilterStats
): TradeResult[] {
  const trades: TradeResult[] = [];
  let tradesToday = 0;

  let position: {
    entryTime: Date;
    entryPrice: number;
    quantity: number;
    targetPrice: number;
    stopPrice: number;
    trailingArmed: boolean;
    peakPrice: number;
    trailingStopPrice: number;
  } | null = null;

  // We need at least (candleCount + 1) candles to have one closed bar for analysis.
  // Loop index i is the "current forming" bar index.
  for (let i = config.candleCount; i < candles5.length; i += 1) {
    const bar = candles5[i];
    const at = bar.time;

    // ---- Exit check for open position ----
    if (position) {
      // Update trailing stop on peak
      if (bar.high > position.peakPrice) {
        position.peakPrice = bar.high;
        const peakPct =
          ((position.peakPrice - position.entryPrice) / position.entryPrice) * 100;
        if (peakPct >= config.trailingArmPct && !position.trailingArmed) {
          position.trailingArmed = true;
          position.trailingStopPrice =
            position.entryPrice * (1 + config.trailingLockPct / 100);
        }
      }

      const activeStop = position.trailingArmed
        ? position.trailingStopPrice
        : position.stopPrice;

      let exitPrice: number | null = null;
      let exitReason: TradeResult['reason'] | null = null;

      // Check intrabar: assume stop hit before target on same candle (conservative)
      if (bar.low <= activeStop) {
        exitPrice = activeStop;
        exitReason = 'STOP_LOSS';
      } else if (bar.high >= position.targetPrice) {
        exitPrice = position.targetPrice;
        exitReason = 'TARGET';
      } else if (isSquareOffTime(at)) {
        exitPrice = bar.close;
        exitReason = 'SQUARE_OFF';
      }

      if (exitPrice !== null && exitReason !== null) {
        const pnl = (exitPrice - position.entryPrice) * position.quantity;
        const pnlPct = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
        const durationMin = Math.round(
          (at.getTime() - position.entryTime.getTime()) / 60_000
        );
        trades.push({
          symbol,
          date: dateKey,
          entryTime: formatIST(position.entryTime),
          entryPrice: position.entryPrice,
          exitPrice,
          quantity: position.quantity,
          pnl: round2(pnl),
          pnlPct: round2(pnlPct),
          reason: exitReason,
          durationMin,
        });
        position = null;
      }
    }

    // ---- Entry check ----
    if (
      position !== null ||
      tradesToday >= config.maxTradesPerDay ||
      isSquareOffTime(at) ||
      !isBuyWindowOpen(at, config.noBuyAfterHour, config.noBuyAfterMinute)
    ) {
      continue;
    }

    // ---- Index (Nifty) trend gate ----
    if (config.useIndexFilter) {
      const idxCandles = indexCandles15.filter((c) => c.time < at).slice(-config.trend15MinCount);
      const idxTrend = analyze15MinTrend(idxCandles);
      if (idxTrend && !idxTrend.aboveSma) {
        // Market in downtrend — skip all buys this bar
        continue;
      }
    }

    // Closed bars: everything before index i
    const closedCandles = candles5.slice(i - config.candleCount, i);
    if (closedCandles.length < config.candleCount) continue;

    // 15-min candles that were closed before the current bar's open time
    const candles15Slice = allCandles15
      .filter((c) => c.time < at)
      .slice(-config.trend15MinCount);

    const trend15 = analyze15MinTrend(candles15Slice);

    const analysis = analyzeCandles(
      closedCandles,
      config.candleCount,
      {
        smaMinMarginPct: config.smaMinMarginPct,
        volumeSpikeMult: config.volumeSpikeMult,
        resistanceMarginPct: config.resistanceMarginPct,
      },
      trend15
    );

    if (!analysis) continue;

    // Track which filter caused the WAIT
    if (analysis.signal === 'WAIT') {
      for (const r of analysis.reasons) {
        if (r.startsWith('FAIL: 15-min')) filterStats.trend15Blocked += 1;
        else if (r.startsWith('FAIL: near resistance')) filterStats.resistanceBlocked += 1;
        else if (r.startsWith('FAIL: RSI')) filterStats.rsiBlocked += 1;
        else if (r.startsWith('FAIL: volume')) filterStats.volumeBlocked += 1;
        else if (r.startsWith('FAIL: close')) filterStats.smaBlocked += 1;
      }
      continue;
    }

    // BUY — entry at the CLOSE of the current forming bar
    const entryPrice = bar.close;
    const quantity = Math.floor(config.amountPerTrade / entryPrice);
    if (quantity < config.minQuantity) continue;

    const targetPrice = entryPrice * (1 + config.profitTargetPct / 100);
    const stopPrice = entryPrice * (1 - config.stopLossPct / 100);

    position = {
      entryTime: at,
      entryPrice,
      quantity,
      targetPrice,
      stopPrice,
      trailingArmed: false,
      peakPrice: entryPrice,
      trailingStopPrice: stopPrice,
    };
    tradesToday += 1;
  }

  // Force-close any position still open at end of day
  if (position !== null && candles5.length > 0) {
    const last = candles5[candles5.length - 1];
    const exitPrice = last.close;
    const pnl = (exitPrice - position.entryPrice) * position.quantity;
    const pnlPct = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
    const durationMin = Math.round(
      (last.time.getTime() - position.entryTime.getTime()) / 60_000
    );
    trades.push({
      symbol,
      date: dateKey,
      entryTime: formatIST(position.entryTime),
      entryPrice: position.entryPrice,
      exitPrice,
      quantity: position.quantity,
      pnl: round2(pnl),
      pnlPct: round2(pnlPct),
      reason: 'SQUARE_OFF',
      durationMin,
    });
  }

  return trades;
}

// ---------------------------------------------------------------------------
// Report printing
// ---------------------------------------------------------------------------

function printSymbolReport(symbol: string, trades: TradeResult[]): void {
  const sym = displaySymbol(symbol);
  console.log(`\nSymbol: ${sym}`);
  console.log(separator());

  if (trades.length === 0) {
    console.log('  No trades generated for this symbol in the period.');
    return;
  }

  // Group by day
  const byDay = new Map<string, TradeResult[]>();
  for (const t of trades) {
    if (!byDay.has(t.date)) byDay.set(t.date, []);
    byDay.get(t.date)!.push(t);
  }

  console.log(
    `${pad('Date', 12)} ${pad('Trades', 7)} ${pad('W', 4)} ${pad('L', 4)} ${rpad('Net PnL', 12)}  Outcome`
  );
  console.log(separator('─', 68));

  let totalPnl = 0;
  let totalW = 0;
  let totalL = 0;

  for (const [date, dayTrades] of [...byDay.entries()].sort()) {
    const dayPnl = dayTrades.reduce((s, t) => s + t.pnl, 0);
    const wins = dayTrades.filter((t) => t.pnl > 0).length;
    const losses = dayTrades.filter((t) => t.pnl <= 0).length;
    totalPnl += dayPnl;
    totalW += wins;
    totalL += losses;

    const outcomes = dayTrades
      .map((t) => {
        const sign = t.pnl > 0 ? '✓' : '✗';
        return `${sign}${t.reason === 'SQUARE_OFF' ? '[SQ]' : ''}`;
      })
      .join(' ');

    console.log(
      `${pad(date, 12)} ${pad(dayTrades.length, 7)} ${pad(wins, 4)} ${pad(losses, 4)} ${rpad(formatRupeeSigned(dayPnl), 12)}  ${outcomes}`
    );
  }

  console.log(separator('─', 68));
  console.log(
    `${pad('TOTAL', 12)} ${pad(totalW + totalL, 7)} ${pad(totalW, 4)} ${pad(totalL, 4)} ${rpad(formatRupeeSigned(totalPnl), 12)}  Win rate: ${totalW + totalL > 0 ? Math.round((totalW / (totalW + totalL)) * 100) : 0}%`
  );
}

function printOverallSummary(
  allTrades: TradeResult[],
  filterStats: FilterStats,
  daysBack: number,
  config: BotConfig
): void {
  const wins = allTrades.filter((t) => t.pnl > 0);
  const losses = allTrades.filter((t) => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = losses.reduce((s, t) => s + t.pnl, 0);
  const netPnl = grossProfit + grossLoss;
  const winRate =
    allTrades.length > 0
      ? Math.round((wins.length / allTrades.length) * 100)
      : 0;
  const avgPerTrade = allTrades.length > 0 ? netPnl / allTrades.length : 0;

  const bestTrade = allTrades.reduce(
    (best, t) => (t.pnl > (best?.pnl ?? -Infinity) ? t : best),
    null as TradeResult | null
  );
  const worstTrade = allTrades.reduce(
    (worst, t) => (t.pnl < (worst?.pnl ?? Infinity) ? t : worst),
    null as TradeResult | null
  );

  const avgDuration =
    allTrades.length > 0
      ? Math.round(allTrades.reduce((s, t) => s + t.durationMin, 0) / allTrades.length)
      : 0;

  const totalFilterBlocked =
    filterStats.trend15Blocked +
    filterStats.resistanceBlocked +
    filterStats.rsiBlocked +
    filterStats.volumeBlocked +
    filterStats.smaBlocked +
    filterStats.momentumBlocked;

  console.log(`\n${separator('═', 68)}`);
  console.log('  OVERALL SUMMARY');
  console.log(separator('═', 68));
  console.log(`  Period:           Last ${daysBack} calendar days`);
  console.log(`  Symbols:          ${config.watchlist.map(displaySymbol).join(', ')}`);
  console.log(
    `  Strategy:         SMA${config.smaMinMarginPct}% | RSI40-65 | Vol${config.volumeSpikeMult}x | Res${config.resistanceMarginPct}% | Trail+${config.trailingArmPct}%`
  );
  console.log(`  Capital/trade:    ${formatRupee(config.amountPerTrade)}`);
  console.log(separator('─', 68));
  console.log(`  Total trades:     ${allTrades.length}`);
  console.log(`  Wins:             ${wins.length}  (${winRate}%)`);
  console.log(`  Losses:           ${losses.length}  (${100 - winRate}%)`);
  console.log(`  Gross profit:     ${formatRupeeSigned(grossProfit)}`);
  console.log(`  Gross loss:       ${formatRupeeSigned(grossLoss)}`);
  console.log(`  Net PnL:          ${formatRupeeSigned(netPnl)}`);
  console.log(`  Avg per trade:    ${formatRupeeSigned(avgPerTrade)}`);
  console.log(`  Avg hold time:    ${avgDuration} min`);
  if (bestTrade) {
    console.log(
      `  Best trade:       ${formatRupeeSigned(bestTrade.pnl)} — ${displaySymbol(bestTrade.symbol)} on ${bestTrade.date}`
    );
  }
  if (worstTrade) {
    console.log(
      `  Worst trade:      ${formatRupeeSigned(worstTrade.pnl)} — ${displaySymbol(worstTrade.symbol)} on ${worstTrade.date}`
    );
  }
  console.log(separator('─', 68));
  console.log(`  Filter impact (signals blocked — saved you from bad trades):`);
  console.log(`    15-min downtrend : ${rpad(filterStats.trend15Blocked, 4)} blocks`);
  console.log(`    Resistance ceiling: ${rpad(filterStats.resistanceBlocked, 4)} blocks`);
  console.log(`    SMA trend (5-min): ${rpad(filterStats.smaBlocked, 4)} blocks`);
  console.log(`    RSI range (40-65): ${rpad(filterStats.rsiBlocked, 4)} blocks`);
  console.log(`    Volume spike     : ${rpad(filterStats.volumeBlocked, 4)} blocks`);
  console.log(`    Momentum (green) : ${rpad(filterStats.momentumBlocked, 4)} blocks`);
  console.log(`    Total            : ${rpad(totalFilterBlocked, 4)} signals skipped`);
  console.log(separator('═', 68));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const daysBack = Number(process.argv[2] ?? 30);
  if (isNaN(daysBack) || daysBack < 1 || daysBack > 60) {
    console.error('Usage: npm run backtest -- [days]  (1-60, default 30)');
    process.exit(1);
  }

  const config = loadConfig({ dryRun: true });
  const creds = loadAngelCredentials();
  const client = new AngelOneClient(creds);

  console.log(`\n${'='.repeat(68)}`);
  console.log(`  BACKTEST ENGINE — Angel One historical data`);
  console.log(`${'='.repeat(68)}`);
  console.log(`  Symbols : ${config.watchlist.map(displaySymbol).join(', ')}`);
  console.log(`  Period  : last ${daysBack} days`);
  console.log(`  Capital : ${formatRupee(config.amountPerTrade)} per trade`);
  console.log(`  Target  : +${config.profitTargetPct}% | Stop: -${config.stopLossPct}%`);
  console.log(`  Cutoff  : ${config.noBuyAfterHour}:${String(config.noBuyAfterMinute).padStart(2, '0')} IST`);
  console.log(
    `  Index   : ${config.useIndexFilter ? `${displaySymbol(config.indexSymbol)} 15-min SMA20 gate` : 'disabled'}`
  );
  console.log('');

  console.log('Logging in to Angel One...');
  await client.login();
  console.log('Login OK.\n');

  // Fetch Nifty index (NIFTYBEES ETF) 15-min candles for the market trend gate
  let indexCandles15: Candle[] = [];
  if (config.useIndexFilter) {
    process.stdout.write(
      `Fetching index candles (${displaySymbol(config.indexSymbol)}) for market trend filter ...`
    );
    try {
      indexCandles15 = await client.getCandles(
        config.exchange,
        config.indexSymbol,
        99_999,
        'FIFTEEN_MINUTE',
        daysBack
      );
      process.stdout.write(` ${indexCandles15.length} bars\n`);
    } catch (err) {
      process.stdout.write(` FAILED (${err instanceof Error ? err.message : err}) — index filter disabled\n`);
    }
    await sleep(6_000);
  }

  const allTrades: TradeResult[] = [];
  const filterStats: FilterStats = {
    trend15Blocked: 0,
    resistanceBlocked: 0,
    rsiBlocked: 0,
    volumeBlocked: 0,
    smaBlocked: 0,
    momentumBlocked: 0,
  };

  for (let si = 0; si < config.watchlist.length; si += 1) {
    const symbol = config.watchlist[si];
    const sym = displaySymbol(symbol);

    if (si > 0) {
      process.stdout.write('  Waiting 6s (rate limit) ...\n');
      await sleep(6_000);
    }

    process.stdout.write(`Fetching 5-min candles for ${sym} ...`);
    const candles5 = await client.getCandles(
      config.exchange,
      symbol,
      99_999,           // fetch everything, we'll use groupByDay to split
      'FIVE_MINUTE',
      daysBack
    );
    process.stdout.write(` ${candles5.length} bars\n`);

    await sleep(6_000);

    process.stdout.write(`Fetching 15-min candles for ${sym} ...`);
    const candles15 = await client.getCandles(
      config.exchange,
      symbol,
      99_999,
      'FIFTEEN_MINUTE',
      daysBack
    );
    process.stdout.write(` ${candles15.length} bars\n`);

    const dayMap = groupByDay(candles5);
    const sortedDays = [...dayMap.keys()].sort();
    console.log(`  ${sortedDays.length} trading days found\n`);

    const symbolTrades: TradeResult[] = [];

    for (const dateKey of sortedDays) {
      const dayCandles5 = dayMap.get(dateKey)!.sort(
        (a, b) => a.time.getTime() - b.time.getTime()
      );

      const dayTrades = simulateDay(
        dateKey,
        symbol,
        dayCandles5,
        candles15,
        indexCandles15,
        config,
        filterStats
      );
      symbolTrades.push(...dayTrades);
      allTrades.push(...dayTrades);
    }

    printSymbolReport(symbol, symbolTrades);
  }

  printOverallSummary(allTrades, filterStats, daysBack, config);
  console.log('');
}

main().catch((err) => {
  console.error('\nBacktest failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
