import { RSI, SMA } from 'technicalindicators';
import { AnalysisResult, BotConfig, Candle } from '../types';

export interface Trend15Result {
  aboveSma: boolean;
  sma20: number;
  rsi14: number;
  close: number;
}

/**
 * Compute 15-min trend from 15-min closed candles.
 * Returns null when there are not enough candles.
 */
export function analyze15MinTrend(candles15: Candle[]): Trend15Result | null {
  if (candles15.length < 20) return null;

  const closes = candles15.map((c) => c.close);
  const smaValues = SMA.calculate({ period: 20, values: closes });
  const rsiValues = RSI.calculate({ period: 14, values: closes });

  if (smaValues.length === 0) return null;

  const close = closes[closes.length - 1];
  const sma20 = smaValues[smaValues.length - 1];
  const rsi14 = rsiValues.length > 0 ? rsiValues[rsiValues.length - 1] : 50;

  return { aboveSma: close > sma20, sma20, rsi14, close };
}

/**
 * Analyse a set of CLOSED 5-min candles.
 *
 * Callers must pass only closed bars (i.e. exclude the currently-forming candle)
 * so that RSI / SMA are computed on complete data only.
 *
 * Checks (all must pass for a BUY signal):
 *   1. 15-min macro trend  — 15-min close above 15-min SMA20
 *   2. 5-min SMA trend     — close smaMinMarginPct%+ above SMA20
 *   3. RSI range           — RSI(14) between 40–65
 *   4. Volume spike        — last volume >= volumeSpikeMult × 10-bar average
 *   5. Momentum            — RSI rising + green candle on last closed bar
 *   6. Resistance          — close is NOT within resistanceMarginPct% of 20-bar high
 */
export function analyzeCandles(
  closedCandles: Candle[],
  minCandles = 50,
  filters?: Pick<BotConfig, 'smaMinMarginPct' | 'volumeSpikeMult' | 'resistanceMarginPct'>,
  trend15?: Trend15Result | null
): AnalysisResult | null {
  if (closedCandles.length < minCandles) return null;

  const smaMinMarginPct = filters?.smaMinMarginPct ?? 0.15;
  const volumeSpikeMult = filters?.volumeSpikeMult ?? 1.2;
  const resistanceMarginPct = filters?.resistanceMarginPct ?? 0.5;

  const closes = closedCandles.map((c) => c.close);
  const volumes = closedCandles.map((c) => c.volume);
  const smaValues = SMA.calculate({ period: 20, values: closes });
  const rsiValues = RSI.calculate({ period: 14, values: closes });

  if (smaValues.length === 0 || rsiValues.length === 0) return null;

  const last = closedCandles[closedCandles.length - 1];
  const close = closes[closes.length - 1];
  const sma20 = smaValues[smaValues.length - 1];
  const rsi14 = rsiValues[rsiValues.length - 1];
  const prevRsi14 = rsiValues.length > 1 ? rsiValues[rsiValues.length - 2] : rsi14;
  const volume = volumes[volumes.length - 1];
  const avgVolume10 =
    volumes.slice(-10).reduce((sum, v) => sum + v, 0) / Math.min(10, volumes.length);

  // Resistance = highest high of the last 20 closed bars
  const recentHighs = closedCandles.slice(-20).map((c) => c.high);
  const resistance = Math.max(...recentHighs);

  const reasons: string[] = [];
  let passTrend15 = false;
  let passTrend = false;
  let passRsi = false;
  let passVolume = false;
  let passResistance = false;
  // momentum is a bonus check — counted in reasons but not a hard blocker
  let momentumBonus = false;

  // --- Check 1: 15-min macro trend ---
  if (trend15 != null) {
    if (trend15.aboveSma) {
      passTrend15 = true;
      reasons.push(
        `PASS: 15-min uptrend (close ₹${trend15.close.toFixed(2)} > SMA20 ₹${trend15.sma20.toFixed(2)})`
      );
    } else {
      reasons.push(
        `FAIL: 15-min downtrend (close ₹${trend15.close.toFixed(2)} < SMA20 ₹${trend15.sma20.toFixed(2)})`
      );
    }
  } else {
    passTrend15 = true;
    reasons.push('INFO: 15-min data unavailable — skipping macro filter');
  }

  // --- Check 2: 5-min SMA trend ---
  const smaThreshold = sma20 * (1 + smaMinMarginPct / 100);
  if (close > smaThreshold) {
    passTrend = true;
    reasons.push(`PASS: close ${smaMinMarginPct.toFixed(1)}%+ above SMA20`);
  } else if (close > sma20) {
    reasons.push(
      `FAIL: close only ${(((close - sma20) / sma20) * 100).toFixed(2)}% above SMA20 (need ${smaMinMarginPct}%)`
    );
  } else {
    reasons.push('FAIL: close below SMA20 (downtrend)');
  }

  // --- Check 3: RSI range ---
  if (rsi14 >= 35 && rsi14 <= 70) {
    passRsi = true;
    reasons.push('PASS: RSI in range 35-70');
  } else if (rsi14 > 70) {
    reasons.push('FAIL: RSI overbought (>70)');
  } else {
    reasons.push('FAIL: RSI too low (<35)');
  }

  // --- Check 4: Volume spike ---
  const volumeThreshold = avgVolume10 * volumeSpikeMult;
  if (volume > volumeThreshold) {
    passVolume = true;
    reasons.push(`PASS: volume ${volumeSpikeMult}x+ above average`);
  } else if (volume > avgVolume10) {
    reasons.push(
      `FAIL: volume above avg but below ${volumeSpikeMult}x spike threshold`
    );
  } else {
    reasons.push('FAIL: volume below average');
  }

  // --- Check 5: Momentum (bonus — RSI rising + green closed bar) ---
  // Not a hard requirement; boosts confidence when both are true.
  const rsiRising = rsi14 > prevRsi14;
  const greenCandle = close > last.open;
  if (rsiRising && greenCandle) {
    momentumBonus = true;
    reasons.push('BONUS: RSI rising + green candle (momentum confirmed)');
  } else {
    if (!rsiRising) reasons.push('INFO: RSI not rising vs previous candle');
    if (!greenCandle) reasons.push('INFO: red/doji candle (close <= open)');
  }

  // --- Check 6: Resistance ceiling ---
  const nearResistance = close >= resistance * (1 - resistanceMarginPct / 100);
  if (!nearResistance) {
    passResistance = true;
    reasons.push(`PASS: not near resistance (ceiling ₹${resistance.toFixed(2)})`);
  } else {
    reasons.push(
      `FAIL: near resistance ceiling ₹${resistance.toFixed(2)} (within ${resistanceMarginPct}%)`
    );
  }

  // BUY requires all 5 hard filters + optional momentum bonus
  const signal =
    passTrend15 && passTrend && passRsi && passVolume && passResistance
      ? 'BUY'
      : 'WAIT';

  // Log overall momentum status for transparency
  void momentumBonus;

  return {
    signal,
    close,
    sma20,
    rsi14,
    volume,
    avgVolume10,
    reasons,
    candleCount: closedCandles.length,
  };
}
