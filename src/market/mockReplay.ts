import { Candle, DemoScenario, MarketDataProvider, ReplayTick } from '../types';
import { addMinutes, makeIST } from '../utils/time';

const WAIT_BELOW_SMA: DemoScenario = {
  signal: 'WAIT',
  close: 649.8,
  sma20: 651.1,
  rsi14: 47.2,
  volume: 8200,
  avgVolume10: 11000,
  reasons: [
    'FAIL: close below SMA20 (downtrend)',
    'PASS: RSI in range 40-65',
    'FAIL: volume below average',
  ],
};

const WAIT_LOW_RSI: DemoScenario = {
  signal: 'WAIT',
  close: 649.2,
  sma20: 650.4,
  rsi14: 38.8,
  volume: 8200,
  avgVolume10: 11000,
  reasons: [
    'FAIL: close below SMA20 (downtrend)',
    'FAIL: RSI too low (<40)',
    'FAIL: volume below average',
  ],
};

const BUY_SIGNAL: DemoScenario = {
  signal: 'BUY',
  close: 651.0,
  sma20: 648.5,
  rsi14: 55.0,
  volume: 14500,
  avgVolume10: 9800,
  reasons: [
    'PASS: close above SMA20',
    'PASS: RSI in range 40-65',
    'PASS: volume above average',
  ],
};

function generateBaseCandles(baseDate: Date, basePrice: number, count: number): Candle[] {
  const candles: Candle[] = [];
  let price = basePrice;
  let time = makeIST(9, 15, 0, baseDate);

  for (let i = 0; i < count; i += 1) {
    const open = price;
    const close = price + 0.1;
    candles.push({
      time,
      open,
      high: close + 0.3,
      low: open - 0.3,
      close,
      volume: 10000,
    });
    price = close;
    time = addMinutes(time, 5);
  }

  return candles;
}

function demoBaseDate(): Date {
  const d = new Date();
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1);
  }
  return d;
}

export class MockMarketReplay implements MarketDataProvider {
  private ticks: ReplayTick[] = [];

  constructor(baseDate = demoBaseDate()) {
    this.ticks = buildDemoDay(baseDate);
  }

  getTicks(): ReplayTick[] {
    return this.ticks;
  }

  isSessionLoggedIn(): boolean {
    return true;
  }

  async getCandles(_symbol: string, count: number, at: Date): Promise<Candle[]> {
    const tick = this.ticks.find((t) => t.at.getTime() === at.getTime());
    if (!tick) return [];
    return tick.candles.slice(-count);
  }

  async get15MinCandles(_symbol: string, _count: number, _at: Date): Promise<Candle[]> {
    return [];
  }

  async getLtp(_symbol: string, at: Date): Promise<number> {
    const tick = this.ticks.find((t) => t.at.getTime() === at.getTime());
    return tick?.ltp ?? 0;
  }
}

export function buildDemoDay(baseDate: Date): ReplayTick[] {
  const candles = generateBaseCandles(baseDate, 648, 50);

  const tick = (
    h: number,
    m: number,
    s: number,
    ltp: number,
    scenario?: DemoScenario
  ): ReplayTick => ({
    at: makeIST(h, m, s, baseDate),
    ltp,
    candles,
    scenario,
  });

  return [
    tick(9, 35, 0, 649.8, WAIT_BELOW_SMA),
    tick(9, 40, 0, 649.2, WAIT_LOW_RSI),
    tick(10, 15, 0, 651.0, BUY_SIGNAL),
    tick(10, 16, 0, 652.4),
    tick(10, 18, 22, 664.1),
    tick(11, 0, 0, 650.0, BUY_SIGNAL),
    tick(11, 0, 5, 649.5),
    tick(11, 1, 5, 636.5),
    tick(11, 35, 0, 651.0, BUY_SIGNAL),
    tick(11, 38, 0, 664.2),
    tick(12, 30, 0, 650.0, BUY_SIGNAL),
    tick(12, 33, 0, 663.2),
    tick(14, 20, 0, 651.0, BUY_SIGNAL),
    tick(14, 23, 0, 664.1),
    tick(15, 30, 0, 652.0),
  ];
}
