export type TradeType = 'INTRADAY' | 'DELIVERY';
export type Signal = 'BUY' | 'WAIT';
export type SellReason = 'TARGET_HIT' | 'STOP_LOSS_HIT' | 'TRAILING_STOP_HIT' | 'INTRADAY_SQUARE_OFF';

export interface Candle {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BotConfig {
  dryRun: boolean;
  symbol: string;
  watchlist: string[];
  exchange: string;
  tradeType: TradeType;
  maxTradesPerDay: number;
  maxOpenPositions: number;
  amountPerTrade: number;
  profitTargetPct: number;
  stopLossPct: number;
  dailyLossCap: number;
  cooldownAfterStopMin: number;
  candleCount: number;
  analyzeEverySec: number;
  analyzeRotateSec: number;
  monitorEverySec: number;
  apiErrorBackoffSec: number;
  candleRefreshSec: number;
  noBuyAfterHour: number;
  noBuyAfterMinute: number;
  minQuantity: number;
  smaMinMarginPct: number;
  volumeSpikeMult: number;
  trailingArmPct: number;
  trailingLockPct: number;
  trend15MinCount: number;
  resistanceMarginPct: number;
  useIndexFilter: boolean;
  indexSymbol: string;
  useMockData: boolean;
}

export interface AnalysisResult {
  signal: Signal;
  close: number;
  sma20: number;
  rsi14: number;
  volume: number;
  avgVolume10: number;
  reasons: string[];
  candleCount: number;
}

export interface OpenPosition {
  symbol: string;
  entryPrice: number;
  quantity: number;
  targetPrice: number;
  stopPrice: number;
  entryTime: Date;
  tradeNumber: number;
  protectionMode?: 'virtual' | 'robo' | 'limit_sl';
  brokerOrderId?: string;
  peakPrice?: number;
  trailingStopPrice?: number;
  trailingArmed?: boolean;
}

export interface ProtectedEntryParams {
  symbol: string;
  exchange: string;
  tradeType: TradeType;
  entryPrice: number;
  targetPrice: number;
  stopPrice: number;
  quantity: number;
}

export interface ProtectedEntryResult {
  mode: 'virtual' | 'robo' | 'limit_sl';
  orderId?: string;
  note: string;
}

export interface ClosedTrade {
  symbol: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  reason: SellReason;
  pnl: number;
  pnlPct: number;
  entryTime: Date;
  exitTime: Date;
  tradeNumber: number;
}

export interface DayState {
  tradesToday: number;
  dayPnl: number;
  wins: number;
  losses: number;
  grossProfit: number;
  grossLoss: number;
  signalsChecked: number;
  buySignals: number;
  skippedSignals: number;
  maxDrawdown: number;
  stopped: boolean;
  stopReason?: string;
  cooldownUntilBySymbol: Record<string, Date>;
  openPositions: OpenPosition[];
  closedTrades: ClosedTrade[];
}

export interface MarketDataProvider {
  getCandles(symbol: string, count: number, at: Date): Promise<Candle[]>;
  get15MinCandles?(symbol: string, count: number, at: Date): Promise<Candle[]>;
  getLtp(symbol: string, at: Date): Promise<number>;
  isSessionLoggedIn(): boolean;
  connect?(): Promise<void>;
  startLiveFeed?(
    symbols: string[],
    onTick: (symbol: string, ltp: number, at: Date) => void
  ): Promise<void>;
  stopLiveFeed?(): Promise<void>;
  placeProtectedEntry?(params: ProtectedEntryParams): Promise<ProtectedEntryResult>;
  hasLiveFeed?(): boolean;
  prefetchSymbols?(symbols: string[]): Promise<void>;
}

export interface ReplayTick {
  at: Date;
  ltp: number;
  candles: Candle[];
  scenario?: DemoScenario;
}

export interface DemoScenario {
  signal: Signal;
  reasons: string[];
  close: number;
  sma20: number;
  rsi14: number;
  volume: number;
  avgVolume10: number;
}
