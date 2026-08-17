import { BotLogger } from '../logger';
import { displaySymbol, formatRupee, formatRupeeSigned, loadConfig } from '../config';
import { analyze15MinTrend, analyzeCandles } from './analyzer';
import {
  calcQuantity,
  canOpenNewTrade,
  checkExit,
  closePosition,
  createDayState,
  getOpenPosition,
  openPosition,
  updateTrailingStop,
} from './risk';
import {
  BotConfig,
  DayState,
  DemoScenario,
  MarketDataProvider,
  OpenPosition,
  ReplayTick,
  SellReason,
} from '../types';
import {
  durationText,
  formatBuyCutoff,
  isBuyWindowOpen,
  isMarketOpen,
  isSquareOffTime,
  istDateKey,
  marketOpenTime,
  shouldAnalyzeNow,
} from '../utils/time';

export class TradingBotEngine {
  private config: BotConfig;
  private logger: BotLogger;
  private market: MarketDataProvider;
  private state: DayState;
  private lastMonitorLogAt = new Map<string, number>();
  private errorBackoffUntil = 0;
  private analyzeRotateIndex = 0;
  /** Dynamic watchlist — starts as config.watchlist, updated by scanner at session start. */
  private activeWatchlist: string[];

  constructor(config: BotConfig, logger: BotLogger, market: MarketDataProvider, state: DayState) {
    this.config = config;
    this.logger = logger;
    this.market = market;
    this.state = state;
    this.activeWatchlist = [...config.watchlist];
  }

  /**
   * Replace the watchlist with scanner-selected symbols.
   * Call this before runLiveSession() starts.
   */
  updateActiveWatchlist(symbols: string[]): void {
    this.activeWatchlist = symbols;
    this.analyzeRotateIndex = 0;
  }

  getActiveWatchlist(): string[] {
    return [...this.activeWatchlist];
  }

  logBotStart(at: Date): void {
    this.logger.botStart(at, {
      mode: this.config.dryRun ? 'DRY_RUN' : 'LIVE',
      watchlist: this.activeWatchlist.join(', '),
      exchange: this.config.exchange,
      tradeType: this.config.tradeType,
      maxTradesPerDay: this.config.maxTradesPerDay,
      maxOpenPositions: this.config.maxOpenPositions,
      amountPerTrade: formatRupee(this.config.amountPerTrade),
      profitTarget: `${this.config.profitTargetPct}%`,
      stopLoss: `${this.config.stopLossPct}%`,
      trailingStop: `arm +${this.config.trailingArmPct}% lock +${this.config.trailingLockPct}%`,
      smaMinMargin: `${this.config.smaMinMarginPct}%`,
      volumeSpike: `${this.config.volumeSpikeMult}x`,
      trend15MinCount: `${this.config.trend15MinCount} bars`,
      resistanceMargin: `${this.config.resistanceMarginPct}%`,
      indexFilter: this.config.useIndexFilter
        ? `${displaySymbol(this.config.indexSymbol)} 15-min SMA20`
        : 'disabled',
      dailyLossCap: formatRupee(this.config.dailyLossCap),
      minQuantity: this.config.minQuantity,
      noBuyAfter: formatBuyCutoff(this.config.noBuyAfterHour, this.config.noBuyAfterMinute),
      analyzeRotateSec: `${this.config.analyzeRotateSec}s`,
      candleRefreshSec: `${this.config.candleRefreshSec}s`,
      ltpFeed: this.market.hasLiveFeed?.() ? 'websocket' : 'polling',
      session: this.market.isSessionLoggedIn() ? 'logged_in (TOTP ok)' : 'mock_session',
    });
  }

  private onPriceTick(symbol: string, ltp: number, at: Date): void {
    this.handlePriceUpdate(symbol, ltp, at);
  }

  private handlePriceUpdate(symbol: string, ltp: number, at: Date): void {
    const position = getOpenPosition(this.state, symbol);
    if (!position) return;

    if (updateTrailingStop(position, ltp, this.config)) {
      this.logger.trailingStopArmed(at, {
        symbol: displaySymbol(symbol),
        peak: formatRupee(position.peakPrice ?? ltp),
        lockStop: formatRupee(position.trailingStopPrice ?? 0),
        note: `profit peaked +${this.config.trailingArmPct}% — stop raised to lock +${this.config.trailingLockPct}%`,
      });
    }

    const exitReason = this.resolveExitReason(position, ltp, at);
    if (exitReason) {
      this.executeSell(symbol, at, ltp, exitReason);
      return;
    }

    const lastLog = this.lastMonitorLogAt.get(symbol) ?? 0;
    if (at.getTime() - lastLog < this.config.monitorEverySec * 1000) {
      return;
    }

    this.lastMonitorLogAt.set(symbol, at.getTime());
    this.logPositionMonitor(symbol, at, ltp, null);
  }

  private resolveExitReason(position: OpenPosition, ltp: number, at: Date): SellReason | null {
    const priceExit = checkExit(position, ltp, false);
    const squareOff = this.config.tradeType === 'INTRADAY' && isSquareOffTime(at);
    return priceExit ?? (squareOff ? 'INTRADAY_SQUARE_OFF' : null);
  }

  private resolveAnalyzeAction(signal: string, at: Date): string {
    if (signal !== 'BUY') return 'NO_ORDER';
    if (!isBuyWindowOpen(at, this.config.noBuyAfterHour, this.config.noBuyAfterMinute)) {
      return `NO_ORDER (after ${formatBuyCutoff(this.config.noBuyAfterHour, this.config.noBuyAfterMinute)} buy cutoff)`;
    }
    if (this.state.openPositions.length >= this.config.maxOpenPositions) {
      return `NO_ORDER (max open positions ${this.config.maxOpenPositions})`;
    }
    return 'WOULD_BUY';
  }

  private logScenarioAnalyze(at: Date, scenario: DemoScenario): void {
    this.state.signalsChecked += 1;

    this.logger.analyze(at, {
      symbol: displaySymbol(this.config.symbol),
      candles: `${this.config.candleCount} x 5min`,
      close: scenario.close,
      sma20: scenario.sma20,
      rsi14: scenario.rsi14,
      volume: scenario.volume,
      avgVolume10: scenario.avgVolume10,
      signal: scenario.signal,
      reasons: scenario.reasons,
      openPosition: this.formatOpenPositions(),
      tradesToday: `${this.state.tradesToday}/${this.config.maxTradesPerDay}`,
      action: this.resolveAnalyzeAction(scenario.signal, at),
    });
  }

  private logAnalyze(
    symbol: string,
    at: Date,
    analysis: NonNullable<ReturnType<typeof analyzeCandles>>
  ): void {
    this.state.signalsChecked += 1;

    this.logger.analyze(at, {
      symbol: displaySymbol(symbol),
      candles: `${analysis.candleCount} x 5min (closed bars only)`,
      close: analysis.close,
      sma20: analysis.sma20,
      rsi14: analysis.rsi14,
      volume: analysis.volume,
      avgVolume10: analysis.avgVolume10,
      signal: analysis.signal,
      reasons: analysis.reasons,
      openPosition: this.formatOpenPositions(),
      tradesToday: `${this.state.tradesToday}/${this.config.maxTradesPerDay}`,
      action: this.resolveAnalyzeAction(analysis.signal, at),
    });
  }

  private formatOpenPositions(): string {
    if (this.state.openPositions.length === 0) return 'none';
    return this.state.openPositions
      .map((p) => `${displaySymbol(p.symbol)} x${p.quantity} @ ${formatRupee(p.entryPrice)}`)
      .join(', ');
  }

  private async executeBuy(symbol: string, at: Date, entryPrice: number): Promise<void> {
    const block = canOpenNewTrade(this.state, this.config, at, symbol);
    if (block) {
      this.state.skippedSignals += 1;
      if (block === 'after buy cutoff time') {
        this.logger.error(
          at,
          'SKIP_TRADE',
          `${displaySymbol(symbol)}: no new buys after ${formatBuyCutoff(this.config.noBuyAfterHour, this.config.noBuyAfterMinute)}`,
          'NO_ORDER'
        );
      } else if (block === 'max open positions reached') {
        this.logger.error(
          at,
          'SKIP_TRADE',
          `${displaySymbol(symbol)}: max open positions ${this.config.maxOpenPositions} reached`,
          'NO_ORDER'
        );
      }
      return;
    }

    const quantity = calcQuantity(this.config.amountPerTrade, entryPrice);
    if (quantity < this.config.minQuantity) {
      this.state.skippedSignals += 1;
      this.logger.error(
        at,
        'SKIP_TRADE',
        `${displaySymbol(symbol)}: quantity ${quantity} below MIN_QUANTITY ${this.config.minQuantity} at ${formatRupee(entryPrice)}`,
        'NO_ORDER'
      );
      return;
    }

    const position = openPosition(this.state, this.config, symbol, entryPrice, at);
    if (!position) {
      this.state.skippedSignals += 1;
      return;
    }

    this.state.buySignals += 1;
    const value = position.quantity * position.entryPrice;
    const common = {
      symbol: displaySymbol(symbol),
      price: formatRupee(position.entryPrice),
      quantity: position.quantity,
      value: formatRupee(value),
      cap: `${formatRupee(this.config.amountPerTrade)} (OK)`,
      targetSell: `${formatRupee(position.targetPrice)} (+${this.config.profitTargetPct}%)`,
      stopSell: `${formatRupee(position.stopPrice)} (-${this.config.stopLossPct}%)`,
      openPosition: this.formatOpenPositions(),
      tradesToday: `${this.state.tradesToday}/${this.config.maxTradesPerDay} (opens trade #${position.tradeNumber})`,
    };

    if (this.config.dryRun) {
      position.protectionMode = 'virtual';
      this.logger.dryRunBuy(at, {
        orderType: 'LIMIT (simulated)',
        ...common,
        note: 'NO real order sent to Angel One',
      });
      this.logger.protectionArmed(at, {
        symbol: displaySymbol(symbol),
        mode: 'virtual_instant_sl_target',
        target: formatRupee(position.targetPrice),
        stop: formatRupee(position.stopPrice),
        note: 'WebSocket/poll ticks trigger SL/target instantly like broker orders',
      });
      return;
    }

    if (!this.market.placeProtectedEntry) {
      this.state.openPositions = this.state.openPositions.filter((p) => p.symbol !== symbol);
      throw new Error('Live orders not available for this market provider');
    }

    const result = await this.market.placeProtectedEntry({
      symbol,
      exchange: this.config.exchange,
      tradeType: this.config.tradeType,
      entryPrice: position.entryPrice,
      targetPrice: position.targetPrice,
      stopPrice: position.stopPrice,
      quantity: position.quantity,
    });

    position.protectionMode = result.mode;
    position.brokerOrderId = result.orderId;

    this.logger.liveBuy(at, {
      orderType: this.config.tradeType === 'INTRADAY' ? 'ROBO bracket' : 'LIMIT + SL',
      orderId: result.orderId ?? 'pending',
      ...common,
      note: result.note,
    });
    this.logger.protectionArmed(at, {
      symbol: displaySymbol(symbol),
      mode: result.mode,
      target: formatRupee(position.targetPrice),
      stop: formatRupee(position.stopPrice),
      note: 'Angel One broker orders active for target and stop-loss',
    });
  }

  private logPositionMonitor(
    symbol: string,
    at: Date,
    ltp: number,
    exitReason: SellReason | null
  ): void {
    const position = getOpenPosition(this.state, symbol);
    if (!position) return;

    const unrealized = (ltp - position.entryPrice) * position.quantity;
    const unrealizedPct = ((ltp - position.entryPrice) / position.entryPrice) * 100;
    const needTargetPct = ((position.targetPrice - ltp) / ltp) * 100;
    const activeStopPrice = position.trailingArmed
      ? position.trailingStopPrice!
      : position.stopPrice;
    const needStopPct = ((ltp - activeStopPrice) / ltp) * 100;

    this.logger.positionMonitor(at, {
      symbol: displaySymbol(symbol),
      entry: formatRupee(position.entryPrice),
      ltp: formatRupee(ltp),
      unrealized: `${formatRupeeSigned(unrealized)} (${unrealizedPct >= 0 ? '+' : ''}${unrealizedPct.toFixed(2)}%)`,
      target: `${formatRupee(position.targetPrice)} (need +${Math.max(0, needTargetPct).toFixed(2)}% more)`,
      stop: `${formatRupee(activeStopPrice)}${position.trailingArmed ? ' (trailing)' : ''} (-${Math.max(0, needStopPct).toFixed(2)}%)`,
      wouldTrigger: exitReason ?? 'none',
      skipNewBuy: `open ${this.state.openPositions.length}/${this.config.maxOpenPositions}`,
    });
  }

  private executeSell(symbol: string, at: Date, ltp: number, reason: SellReason): void {
    const position = getOpenPosition(this.state, symbol);
    if (!position) return;

    const exitPrice =
      reason === 'TARGET_HIT'
        ? position.targetPrice
        : reason === 'STOP_LOSS_HIT'
          ? position.stopPrice
          : ltp;

    const trade = closePosition(this.state, this.config, position, exitPrice, reason, at);
    const level = reason === 'INTRADAY_SQUARE_OFF' ? 'WARN' : 'INFO';

    const sellData = {
      symbol: displaySymbol(symbol),
      reason,
      entry: formatRupee(trade.entryPrice),
      exit: `${formatRupee(trade.exitPrice)} (LTP ${formatRupee(ltp)})`,
      quantity: trade.quantity,
      pnl: `${formatRupeeSigned(trade.pnl)} (${trade.pnlPct >= 0 ? '+' : ''}${trade.pnlPct.toFixed(2)}% on price)`,
      duration: durationText(trade.entryTime, trade.exitTime),
      note: this.sellNote(reason, position),
      openPosition: this.formatOpenPositions(),
      tradesToday: `${this.state.tradesToday}/${this.config.maxTradesPerDay}`,
      dayPnl: formatRupeeSigned(this.state.dayPnl),
    };

    if (this.config.dryRun) {
      this.logger.dryRunSell(at, sellData, level);
    } else {
      this.logger.liveSell(at, sellData, level);
    }

    if (reason === 'STOP_LOSS_HIT') {
      const cooldownUntil = this.state.cooldownUntilBySymbol[symbol];
      if (cooldownUntil) {
        this.logger.cooldown(at, `stop_loss on ${displaySymbol(symbol)}`, cooldownUntil);
      }
    }

    if (this.state.stopped && this.state.stopReason?.includes('dailyLossCap')) {
      this.logger.botStop(at, this.state.stopReason, true);
    } else if (this.state.stopped && this.state.stopReason?.includes('maxTradesPerDay')) {
      this.logger.botPause(at, `maxTradesPerDay reached (${this.config.maxTradesPerDay})`, 'next trading day');
    }
  }

  private sellNote(reason: SellReason, position: OpenPosition): string {
    if (this.config.dryRun) {
      if (reason === 'TARGET_HIT') return 'instant simulated LIMIT target fill (WebSocket tick)';
      if (reason === 'STOP_LOSS_HIT') return 'instant simulated SL fill (WebSocket tick)';
      if (reason === 'TRAILING_STOP_HIT') {
        return `trailing stop hit — locked +${this.config.trailingLockPct}% after peak +${this.config.trailingArmPct}%`;
      }
      return 'would force close before market close';
    }

    if (reason === 'TARGET_HIT' || reason === 'STOP_LOSS_HIT' || reason === 'TRAILING_STOP_HIT') {
      return position.protectionMode === 'robo'
        ? 'broker ROBO target/SL filled on Angel One'
        : 'broker exit order filled on Angel One';
    }

    return 'intraday square-off on Angel One';
  }

  private async runAnalyzeForSymbol(at: Date, symbol: string): Promise<void> {
    // Fetch one extra candle so we can exclude the currently-forming bar.
    // The last candle from the API is still building; excluding it ensures
    // RSI / SMA are computed on fully-closed bars only.
    const rawCandles = await this.market.getCandles(symbol, this.config.candleCount + 1, at);
    if (rawCandles.length <= this.config.candleCount) {
      this.logger.error(
        at,
        'SKIP_TRADE',
        `${displaySymbol(symbol)}: insufficient candle data (${rawCandles.length} bars, need ${this.config.candleCount + 1})`,
        'NO_ORDER'
      );
      return;
    }
    // Use only the first `candleCount` entries — all confirmed closed bars.
    const closedCandles = rawCandles.slice(0, this.config.candleCount);

    // 15-min macro trend — cached; does not add a new API call every cycle.
    let trend15 = null;
    if (this.market.get15MinCandles) {
      try {
        const candles15 = await this.market.get15MinCandles(
          symbol,
          this.config.trend15MinCount,
          at
        );
        trend15 = analyze15MinTrend(candles15);
      } catch {
        // 15-min unavailable; analyzer will skip the check.
      }
    }

    const analysis = analyzeCandles(closedCandles, this.config.candleCount, {
      smaMinMarginPct: this.config.smaMinMarginPct,
      volumeSpikeMult: this.config.volumeSpikeMult,
      resistanceMarginPct: this.config.resistanceMarginPct,
    }, trend15);
    if (!analysis) {
      this.logger.error(at, 'SKIP_TRADE', `${displaySymbol(symbol)}: analysis failed`, 'NO_ORDER');
      return;
    }

    this.logAnalyze(symbol, at, analysis);

    if (analysis.signal !== 'BUY') return;
    if (!isBuyWindowOpen(at, this.config.noBuyAfterHour, this.config.noBuyAfterMinute)) {
      this.state.skippedSignals += 1;
      return;
    }

    const ltp = await this.market.getLtp(symbol, at);
    await this.executeBuy(symbol, at, ltp);
  }

  private async getIndexTrend(at: Date): Promise<boolean> {
    if (!this.config.useIndexFilter || !this.market.get15MinCandles) return true;

    try {
      const candles15 = await this.market.get15MinCandles(
        this.config.indexSymbol,
        this.config.trend15MinCount,
        at
      );
      const trend = analyze15MinTrend(candles15);
      if (!trend) return true; // not enough data → don't block
      return trend.aboveSma;
    } catch {
      return true; // on error, don't block trading
    }
  }

  private async analyzeNextSymbol(at: Date): Promise<void> {
    if (this.state.stopped || !shouldAnalyzeNow(at)) return;

    const symbols = this.activeWatchlist;
    if (symbols.length === 0) return;

    // Gate: overall market (Nifty via index ETF) must be in uptrend
    const marketUp = await this.getIndexTrend(at);
    if (!marketUp) {
      this.logger.error(
        at,
        'MARKET_WEAK',
        `${displaySymbol(this.config.indexSymbol)} 15-min below SMA20 — market in downtrend`,
        'NO_BUY (all symbols skipped until Nifty recovers)'
      );
      return;
    }

    for (let i = 0; i < symbols.length; i += 1) {
      const idx = (this.analyzeRotateIndex + i) % symbols.length;
      const symbol = symbols[idx];

      if (getOpenPosition(this.state, symbol)) continue;

      await this.runAnalyzeForSymbol(at, symbol);
      this.analyzeRotateIndex = (idx + 1) % symbols.length;
      return;
    }
  }

  private async refreshOpenPositions(at: Date): Promise<void> {
    for (const position of [...this.state.openPositions]) {
      const ltp = await this.market.getLtp(position.symbol, at);
      this.handlePriceUpdate(position.symbol, ltp, at);
    }
  }

  private logDaySummary(at: Date): void {
    const winRate =
      this.state.tradesToday > 0
        ? `${Math.round((this.state.wins / this.state.tradesToday) * 100)}%`
        : '0%';

    this.logger.daySummary(at, {
      date: istDateKey(at),
      mode: this.config.dryRun ? 'DRY_RUN' : 'LIVE',
      watchlist: this.activeWatchlist.map(displaySymbol).join(', '),
      totalTrades: this.state.tradesToday,
      wins: this.state.wins,
      losses: this.state.losses,
      winRate,
      grossProfit: formatRupeeSigned(this.state.grossProfit),
      grossLoss: formatRupeeSigned(this.state.grossLoss),
      netPnl: formatRupeeSigned(this.state.dayPnl),
      maxDrawdown: formatRupeeSigned(this.state.maxDrawdown),
      signalsChecked: this.state.signalsChecked,
      buySignals: this.state.buySignals,
      skippedSignals: this.state.skippedSignals,
    });
  }

  async runLiveSession(): Promise<void> {
    const start = new Date();

    if (!isMarketOpen(start)) {
      this.logger.marketWait(start, 'market closed — waiting for 09:15 IST on weekdays', marketOpenTime(start));
      console.log('Market is closed. Run this bot during NSE hours (Mon–Fri 9:15 AM – 3:30 PM IST).');
      return;
    }

    if (this.market.startLiveFeed) {
      try {
        await this.market.startLiveFeed(this.activeWatchlist, (symbol, ltp, at) =>
          this.onPriceTick(symbol, ltp, at)
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          start,
          'WS_START_FAILED',
          message,
          'continuing without WebSocket — REST polling for open positions'
        );
      }
    }

    this.logBotStart(start);

    let lastAnalyzeAt = 0;
    let daySummaryLogged = false;

    try {
      while (!this.state.stopped) {
        const now = new Date();

        if (!isMarketOpen(now)) {
          await this.refreshOpenPositions(now);
          if (!daySummaryLogged) {
            this.logDaySummary(now);
            daySummaryLogged = true;
          }
          break;
        }

        if (Date.now() < this.errorBackoffUntil) {
          await sleep(1000);
          continue;
        }

        try {
          if (
            shouldAnalyzeNow(now) &&
            now.getTime() - lastAnalyzeAt >= this.config.analyzeRotateSec * 1000
          ) {
            await this.analyzeNextSymbol(now);
            lastAnalyzeAt = now.getTime();
          } else if (this.state.openPositions.length > 0 && !this.market.hasLiveFeed?.()) {
            await this.refreshOpenPositions(now);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.errorBackoffUntil = Date.now() + this.config.apiErrorBackoffSec * 1000;
          this.logger.error(
            now,
            'API_ERROR',
            message,
            `wait ${this.config.apiErrorBackoffSec}s before retry — NO real order placed`
          );
        }

        await sleep(1000);
      }
    } finally {
      await this.market.stopLiveFeed?.();
    }

    if (!daySummaryLogged) {
      this.logDaySummary(new Date());
    }
  }

  async replayDay(ticks: ReplayTick[]): Promise<void> {
    if (ticks.length === 0) return;

    const first = ticks[0].at;
    const preMarket = new Date(first.getTime() - 5 * 60 * 1000);
    this.logger.marketWait(preMarket, 'market opens 09:15 IST', marketOpenTime(first));
    this.logBotStart(preMarket);

    let lastAnalyzeAt = 0;

    for (const tick of ticks) {
      const shouldAnalyze =
        tick.at.getTime() - lastAnalyzeAt >= this.config.analyzeEverySec * 1000;

      if (
        shouldAnalyze &&
        this.state.openPositions.length < this.config.maxOpenPositions &&
        isMarketOpen(tick.at) &&
        !this.state.stopped &&
        shouldAnalyzeNow(tick.at)
      ) {
        if (tick.scenario) {
          this.logScenarioAnalyze(tick.at, tick.scenario);
          if (
            tick.scenario.signal === 'BUY' &&
            isBuyWindowOpen(tick.at, this.config.noBuyAfterHour, this.config.noBuyAfterMinute)
          ) {
            await this.executeBuy(this.config.symbol, tick.at, tick.ltp);
          }
        } else if (tick.candles.length >= this.config.candleCount) {
          const analysis = analyzeCandles(tick.candles, this.config.candleCount, {
            smaMinMarginPct: this.config.smaMinMarginPct,
            volumeSpikeMult: this.config.volumeSpikeMult,
            resistanceMarginPct: this.config.resistanceMarginPct,
          });
          if (analysis) {
            this.logAnalyze(this.config.symbol, tick.at, analysis);
            if (
              analysis.signal === 'BUY' &&
              isBuyWindowOpen(tick.at, this.config.noBuyAfterHour, this.config.noBuyAfterMinute)
            ) {
              await this.executeBuy(this.config.symbol, tick.at, tick.ltp);
            }
          }
        }
        lastAnalyzeAt = tick.at.getTime();
      }

      for (const position of [...this.state.openPositions]) {
        if (position.symbol === this.config.symbol) {
          this.onPriceTick(this.config.symbol, tick.ltp, tick.at);
        }
      }

      if (this.state.stopped) break;
    }

    const lastTick = ticks[ticks.length - 1];
    this.logDaySummary(new Date(lastTick.at.getTime() + 15 * 60 * 1000));
  }
}

export function createEngine(
  market: MarketDataProvider,
  logger: BotLogger,
  config = loadConfig(),
  state = createDayState()
): TradingBotEngine {
  return new TradingBotEngine(config, logger, market, state);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
