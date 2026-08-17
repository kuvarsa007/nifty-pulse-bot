import { round2 } from '../config';
import { BotConfig, ClosedTrade, DayState, OpenPosition, SellReason } from '../types';
import { isBuyWindowOpen } from '../utils/time';

export function createDayState(): DayState {
  return {
    tradesToday: 0,
    dayPnl: 0,
    wins: 0,
    losses: 0,
    grossProfit: 0,
    grossLoss: 0,
    signalsChecked: 0,
    buySignals: 0,
    skippedSignals: 0,
    maxDrawdown: 0,
    stopped: false,
    cooldownUntilBySymbol: {},
    openPositions: [],
    closedTrades: [],
  };
}

export function getOpenPosition(state: DayState, symbol: string): OpenPosition | undefined {
  return state.openPositions.find((p) => p.symbol === symbol);
}

export function calcQuantity(amountPerTrade: number, price: number): number {
  if (price <= 0) return 0;
  return Math.floor(amountPerTrade / price);
}

export function calcTargetPrice(entry: number, profitPct: number): number {
  return round2(entry * (1 + profitPct / 100));
}

export function calcStopPrice(entry: number, stopPct: number): number {
  return round2(entry * (1 - stopPct / 100));
}

export function canOpenNewTrade(
  state: DayState,
  config: BotConfig,
  at: Date,
  symbol: string
): string | null {
  if (state.stopped) return state.stopReason ?? 'bot stopped';
  if (getOpenPosition(state, symbol)) return 'already in position for symbol';
  if (state.openPositions.length >= config.maxOpenPositions) return 'max open positions reached';
  if (state.tradesToday >= config.maxTradesPerDay) return 'max trades reached';

  const cooldownUntil = state.cooldownUntilBySymbol[symbol];
  if (cooldownUntil && at < cooldownUntil) return 'cooldown active';

  if (state.dayPnl <= -config.dailyLossCap) return 'daily loss cap reached';
  if (!isBuyWindowOpen(at, config.noBuyAfterHour, config.noBuyAfterMinute)) {
    return 'after buy cutoff time';
  }
  return null;
}

export function updateTrailingStop(position: OpenPosition, ltp: number, config: BotConfig): boolean {
  position.peakPrice = Math.max(position.peakPrice ?? position.entryPrice, ltp);
  const peakPct = ((position.peakPrice - position.entryPrice) / position.entryPrice) * 100;

  if (peakPct >= config.trailingArmPct && !position.trailingArmed) {
    position.trailingArmed = true;
    position.trailingStopPrice = calcTargetPrice(position.entryPrice, config.trailingLockPct);
    return true;
  }

  return false;
}

export function checkExit(
  position: OpenPosition,
  ltp: number,
  squareOff: boolean
): SellReason | null {
  if (ltp >= position.targetPrice) return 'TARGET_HIT';
  if (
    position.trailingArmed &&
    position.trailingStopPrice !== undefined &&
    ltp <= position.trailingStopPrice
  ) {
    return 'TRAILING_STOP_HIT';
  }
  if (ltp <= position.stopPrice) return 'STOP_LOSS_HIT';
  if (squareOff) return 'INTRADAY_SQUARE_OFF';
  return null;
}

export function closePosition(
  state: DayState,
  config: BotConfig,
  position: OpenPosition,
  exitPrice: number,
  reason: SellReason,
  at: Date
): ClosedTrade {
  const pnl = round2((exitPrice - position.entryPrice) * position.quantity);
  const pnlPct = round2(((exitPrice - position.entryPrice) / position.entryPrice) * 100);
  const trade: ClosedTrade = {
    symbol: position.symbol,
    entryPrice: position.entryPrice,
    exitPrice,
    quantity: position.quantity,
    reason,
    pnl,
    pnlPct,
    entryTime: position.entryTime,
    exitTime: at,
    tradeNumber: position.tradeNumber,
  };

  state.tradesToday += 1;
  state.dayPnl = round2(state.dayPnl + pnl);
  state.closedTrades.push(trade);
  state.openPositions = state.openPositions.filter((p) => p.symbol !== position.symbol);

  if (pnl >= 0) {
    state.wins += 1;
    state.grossProfit = round2(state.grossProfit + pnl);
  } else {
    state.losses += 1;
    state.grossLoss = round2(state.grossLoss + pnl);
  }

  if (state.dayPnl < state.maxDrawdown) {
    state.maxDrawdown = state.dayPnl;
  }

  if (reason === 'STOP_LOSS_HIT') {
    state.cooldownUntilBySymbol[position.symbol] = new Date(
      at.getTime() + config.cooldownAfterStopMin * 60 * 1000
    );
  }

  if (state.dayPnl <= -config.dailyLossCap) {
    state.stopped = true;
    state.stopReason = `dailyLossCap exceeded (${state.dayPnl} <= cap -${config.dailyLossCap})`;
  }

  if (state.tradesToday >= config.maxTradesPerDay) {
    state.stopped = true;
    state.stopReason = `maxTradesPerDay reached (${config.maxTradesPerDay})`;
  }

  return trade;
}

export function openPosition(
  state: DayState,
  config: BotConfig,
  symbol: string,
  entryPrice: number,
  at: Date
): OpenPosition | null {
  const block = canOpenNewTrade(state, config, at, symbol);
  if (block) return null;

  const quantity = calcQuantity(config.amountPerTrade, entryPrice);
  if (quantity <= 0) return null;
  if (quantity < config.minQuantity) return null;

  const value = round2(quantity * entryPrice);
  if (value > config.amountPerTrade) return null;

  const position: OpenPosition = {
    symbol,
    entryPrice: round2(entryPrice),
    quantity,
    targetPrice: calcTargetPrice(entryPrice, config.profitTargetPct),
    stopPrice: calcStopPrice(entryPrice, config.stopLossPct),
    entryTime: at,
    tradeNumber: state.tradesToday + 1,
    peakPrice: round2(entryPrice),
  };

  state.openPositions.push(position);
  return position;
}
