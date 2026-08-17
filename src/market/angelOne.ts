import { Candle, MarketDataProvider, ProtectedEntryParams, ProtectedEntryResult } from '../types';
import { get5MinBucketKey } from '../utils/time';
import { AngelOneClient, loadAngelCredentials } from './angelOneClient';
import { AngelOneWebSocket, exchangeTypeCode } from './angelOneWebSocket';

interface CandleCache {
  candles: Candle[];
  fetchedAt: number;
  bucketKey: string;
}

interface CandleCache15 {
  candles: Candle[];
  fetchedAt: number;
}

interface FormingVolumeState {
  base: number;
  ticks: number;
}

const TOKEN_FETCH_GAP_MS = 5_000;
const FIFTEEN_MIN_CACHE_MS = 15 * 60 * 1_000;

export class AngelOneMarketData implements MarketDataProvider {
  private client: AngelOneClient;
  private exchange: string;
  private candleRefreshSec: number;
  private loggedIn = false;
  private ws: AngelOneWebSocket | null = null;
  private latestLtp = new Map<string, number>();
  private candleCache = new Map<string, CandleCache>();
  private candleCache15 = new Map<string, CandleCache15>();
  private formingVolume = new Map<string, FormingVolumeState>();
  private tokenToSymbol = new Map<string, string>();
  private symbolToToken = new Map<string, string>();

  constructor(exchange = 'NSE', candleRefreshSec = 1800) {
    this.client = new AngelOneClient(loadAngelCredentials());
    this.exchange = exchange;
    this.candleRefreshSec = candleRefreshSec;
  }

  async connect(): Promise<void> {
    if (this.loggedIn) return;
    await this.client.login();
    this.loggedIn = true;
  }

  isSessionLoggedIn(): boolean {
    return this.loggedIn && this.client.isLoggedIn();
  }

  hasLiveFeed(): boolean {
    return this.ws !== null;
  }

  async prefetchSymbols(symbols: string[]): Promise<void> {
    await this.connect();

    for (let i = 0; i < symbols.length; i += 1) {
      if (i > 0) {
        await sleep(TOKEN_FETCH_GAP_MS);
      }
      const symbol = symbols[i];
      const token = await this.client.getSymbolToken(this.exchange, symbol);
      this.symbolToToken.set(symbol, token);
      this.tokenToSymbol.set(token, symbol);
    }
  }

  async get15MinCandles(symbol: string, count: number, _at: Date): Promise<Candle[]> {
    await this.connect();

    const now = Date.now();
    const cached = this.candleCache15.get(symbol);
    if (cached && now - cached.fetchedAt < FIFTEEN_MIN_CACHE_MS) {
      return cached.candles.slice(-count);
    }

    const candles = await this.client.getCandles(
      this.exchange,
      symbol,
      count,
      'FIFTEEN_MINUTE'
    );
    this.candleCache15.set(symbol, { candles, fetchedAt: now });
    return candles.slice(-count);
  }

  async getCandles(symbol: string, count: number, at: Date): Promise<Candle[]> {
    await this.connect();

    const now = Date.now();
    const currentBucket = get5MinBucketKey(at);
    const cached = this.candleCache.get(symbol);
    const cacheValid =
      cached &&
      cached.bucketKey === currentBucket &&
      now - cached.fetchedAt < this.candleRefreshSec * 1000;

    if (!cacheValid) {
      const candles = await this.client.getCandles(this.exchange, symbol, count);
      this.candleCache.set(symbol, { candles, fetchedAt: now, bucketKey: currentBucket });
      const last = candles[candles.length - 1];
      this.formingVolume.set(symbol, { base: last?.volume ?? 0, ticks: 0 });
    } else {
      const ltp = this.latestLtp.get(symbol);
      if (ltp !== undefined) {
        this.patchFormingCandle(symbol, ltp);
      }
    }

    return (this.candleCache.get(symbol)?.candles ?? []).slice(-count);
  }

  async getLtp(symbol: string, _at: Date): Promise<number> {
    const cached = this.latestLtp.get(symbol);
    if (cached !== undefined) return cached;
    await this.connect();
    const ltp = await this.client.getLtp(this.exchange, symbol);
    this.latestLtp.set(symbol, ltp);
    return ltp;
  }

  async startLiveFeed(
    symbols: string[],
    onTick: (symbol: string, ltp: number, at: Date) => void
  ): Promise<void> {
    await this.connect();

    const tokens: string[] = [];
    for (let i = 0; i < symbols.length; i += 1) {
      const symbol = symbols[i];
      let token = this.symbolToToken.get(symbol);

      if (!token) {
        if (tokens.length > 0) {
          await sleep(TOKEN_FETCH_GAP_MS);
        }
        token = await this.client.getSymbolToken(this.exchange, symbol);
        this.symbolToToken.set(symbol, token);
        this.tokenToSymbol.set(token, symbol);
      }

      tokens.push(token);
    }

    if (this.ws) {
      this.ws.disconnect();
    }

    this.ws = new AngelOneWebSocket(this.client.getSession(), (ltp, at, token) => {
      const mappedSymbol = this.tokenToSymbol.get(token);
      if (!mappedSymbol) return;

      this.latestLtp.set(mappedSymbol, ltp);
      if (this.candleCache.has(mappedSymbol)) {
        this.patchFormingCandle(mappedSymbol, ltp);
      }
      onTick(mappedSymbol, ltp, at);
    });

    await this.ws.connect();
    this.ws.subscribeLtp(exchangeTypeCode(this.exchange), tokens);
  }

  async stopLiveFeed(): Promise<void> {
    this.ws?.disconnect();
    this.ws = null;
  }

  async placeProtectedEntry(params: ProtectedEntryParams): Promise<ProtectedEntryResult> {
    await this.connect();
    return this.client.placeProtectedEntry(params);
  }

  private patchFormingCandle(symbol: string, ltp: number): void {
    const cache = this.candleCache.get(symbol);
    if (!cache || cache.candles.length === 0) return;

    const last = cache.candles[cache.candles.length - 1];
    last.close = ltp;
    if (ltp > last.high) last.high = ltp;
    if (ltp < last.low) last.low = ltp;

    const forming = this.formingVolume.get(symbol) ?? { base: last.volume, ticks: 0 };
    forming.ticks += 1;
    this.formingVolume.set(symbol, forming);
    last.volume = forming.base + forming.ticks * 5000;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
