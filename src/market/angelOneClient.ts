import { authenticator } from 'otplib';
import { round2 } from '../config';
import { Candle, ProtectedEntryParams, ProtectedEntryResult, TradeType } from '../types';
import { formatIST, istDateKey } from '../utils/time';

const BASE_URL = 'https://apiconnect.angelone.in';

export interface AngelOneCredentials {
  apiKey: string;
  clientId: string;
  password: string;
  totpSecret: string;
  localIp?: string;
  publicIp?: string;
}

export interface AngelOneSession {
  jwtToken: string;
  feedToken: string;
  apiKey: string;
  clientId: string;
}

interface LoginResponse {
  status: boolean;
  message: string;
  errorcode?: string;
  data?: {
    jwtToken: string;
    refreshToken: string;
    feedToken: string;
  };
}

interface ApiResponse {
  status: boolean;
  message?: string;
  data?: {
    orderid?: string;
    uniqueorderid?: string;
  };
}

export interface BulkQuoteEntry {
  tradingSymbol: string;
  symbolToken: string;
  open: number;
  high: number;
  low: number;
  close: number;   // previous day close
  ltp: number;
  /** Often missing/0 in OHLC mode — prefer tradeVolume from FULL mode. */
  volume?: number;
  tradeVolume?: number | string;
  percentChange?: number | string;
  netChange?: number | string;
  totBuyQuan?: number;
  totSellQuan?: number;
  weekLow52?: number;
  weekHigh52?: number;
}

export class AngelOneClient {
  private creds: AngelOneCredentials;
  private jwtToken = '';
  private feedToken = '';
  private loggedIn = false;
  private symbolTokenCache = new Map<string, string>();

  constructor(creds: AngelOneCredentials) {
    this.creds = creds;
  }

  isLoggedIn(): boolean {
    return this.loggedIn;
  }

  getSession(): AngelOneSession {
    if (!this.loggedIn) throw new Error('Not logged in to Angel One');
    return {
      jwtToken: this.jwtToken,
      feedToken: this.feedToken,
      apiKey: this.creds.apiKey,
      clientId: this.creds.clientId,
    };
  }

  async login(): Promise<void> {
    const totp = authenticator.generate(this.creds.totpSecret);
    const body = {
      clientcode: this.creds.clientId,
      password: this.creds.password,
      totp,
    };

    const res = await this.request<LoginResponse>(
      '/rest/auth/angelbroking/user/v1/loginByPassword',
      'POST',
      body,
      false
    );

    if (!res.status || !res.data?.jwtToken || !res.data.feedToken) {
      throw new Error(`Angel One login failed: ${res.message || 'unknown error'}`);
    }

    this.jwtToken = res.data.jwtToken;
    this.feedToken = res.data.feedToken;
    this.loggedIn = true;
  }

  async getSymbolToken(exchange: string, symbol: string): Promise<string> {
    const cacheKey = `${exchange}:${symbol}`;
    const cached = this.symbolTokenCache.get(cacheKey);
    if (cached) return cached;

    const searchTerm = symbol.replace('-EQ', '').replace('-BE', '');
    const res = await this.request<{
      status: boolean;
      data?: Array<{ symboltoken: string; tradingsymbol: string }>;
    }>('/rest/secure/angelbroking/order/v1/searchScrip', 'POST', {
      exchange,
      searchscrip: searchTerm,
    });

    const match =
      res.data?.find((row) => row.tradingsymbol === symbol) ??
      res.data?.find((row) => row.tradingsymbol.startsWith(searchTerm));

    if (!match?.symboltoken) {
      throw new Error(`Symbol token not found for ${symbol} on ${exchange}`);
    }

    this.symbolTokenCache.set(cacheKey, match.symboltoken);
    return match.symboltoken;
  }

  async getCandles(
    exchange: string,
    symbol: string,
    count: number,
    interval: 'FIVE_MINUTE' | 'FIFTEEN_MINUTE' = 'FIVE_MINUTE',
    daysBack = 7
  ): Promise<Candle[]> {
    const token = await this.getSymbolToken(exchange, symbol);
    const to = new Date();
    const from = new Date(to.getTime() - daysBack * 24 * 60 * 60 * 1000);

    const res = await this.request<{
      status: boolean;
      data?: Array<[string, number, number, number, number, number]>;
      message?: string;
    }>('/rest/secure/angelbroking/historical/v1/getCandleData', 'POST', {
      exchange,
      symboltoken: token,
      interval,
      fromdate: formatCandleDate(from),
      todate: formatCandleDate(to),
    });

    if (!res.status || !res.data?.length) {
      throw new Error(`Candle fetch failed: ${res.message ?? 'no data'}`);
    }

    const candles = res.data.map((row) => ({
      time: new Date(row[0]),
      open: row[1],
      high: row[2],
      low: row[3],
      close: row[4],
      volume: row[5],
    }));

    return candles.slice(-count);
  }

  /**
   * Fetch OHLC + LTP + volume for multiple tokens in one call.
   * Caller should batch into ≤50 tokens to stay within API limits.
   */
  async getBulkQuotes(
    exchangeTokens: Record<string, string[]>,
    mode: 'LTP' | 'OHLC' | 'FULL' = 'OHLC'
  ): Promise<BulkQuoteEntry[]> {
    const res = await this.request<{
      status: boolean;
      data?: {
        fetched?: BulkQuoteEntry[];
        unfetched?: unknown[];
      };
      message?: string;
    }>('/rest/secure/angelbroking/market/v1/quote/', 'POST', {
      mode,
      exchangeTokens,
    });

    if (!res.status) {
      throw new Error(`Bulk quote failed: ${res.message ?? 'unknown'}`);
    }

    return res.data?.fetched ?? [];
  }

  async getLtp(exchange: string, symbol: string): Promise<number> {
    const token = await this.getSymbolToken(exchange, symbol);
    const res = await this.request<{
      status: boolean;
      data?: {
        fetched: Array<{ ltp?: number }>;
      };
      message?: string;
    }>('/rest/secure/angelbroking/market/v1/quote/', 'POST', {
      mode: 'LTP',
      exchangeTokens: {
        [exchange]: [token],
      },
    });

    const ltp = res.data?.fetched?.[0]?.ltp;
    if (!res.status || ltp === undefined) {
      throw new Error(`LTP fetch failed: ${res.message ?? 'no ltp'}`);
    }

    return ltp;
  }

  async placeProtectedEntry(params: ProtectedEntryParams): Promise<ProtectedEntryResult> {
    const token = await this.getSymbolToken(params.exchange, params.symbol);
    const productType = params.tradeType === 'INTRADAY' ? 'INTRADAY' : 'DELIVERY';
    const targetPoints = round2(params.targetPrice - params.entryPrice);
    const stopPoints = round2(params.entryPrice - params.stopPrice);

    if (params.tradeType === 'INTRADAY') {
      const res = await this.request<ApiResponse>(
        '/rest/secure/angelbroking/order/v1/placeOrder',
        'POST',
        {
          variety: 'ROBO',
          tradingsymbol: params.symbol,
          symboltoken: token,
          transactiontype: 'BUY',
          exchange: params.exchange,
          ordertype: 'LIMIT',
          producttype: productType,
          duration: 'DAY',
          price: params.entryPrice.toFixed(2),
          quantity: String(params.quantity),
          squareoff: targetPoints.toFixed(2),
          stoploss: stopPoints.toFixed(2),
        }
      );

      if (!res.status) {
        throw new Error(`Bracket order failed: ${res.message ?? 'unknown'}`);
      }

      return {
        mode: 'robo',
        orderId: res.data?.orderid,
        note: 'ROBO bracket: LIMIT entry + target + stoploss on Angel One',
      };
    }

    const buyRes = await this.request<ApiResponse>(
      '/rest/secure/angelbroking/order/v1/placeOrder',
      'POST',
      {
        variety: 'NORMAL',
        tradingsymbol: params.symbol,
        symboltoken: token,
        transactiontype: 'BUY',
        exchange: params.exchange,
        ordertype: 'LIMIT',
        producttype: 'DELIVERY',
        duration: 'DAY',
        price: params.entryPrice.toFixed(2),
        quantity: String(params.quantity),
      }
    );

    if (!buyRes.status) {
      throw new Error(`Buy order failed: ${buyRes.message ?? 'unknown'}`);
    }

    await this.request<ApiResponse>('/rest/secure/angelbroking/order/v1/placeOrder', 'POST', {
      variety: 'NORMAL',
      tradingsymbol: params.symbol,
      symboltoken: token,
      transactiontype: 'SELL',
      exchange: params.exchange,
      ordertype: 'LIMIT',
      producttype: 'DELIVERY',
      duration: 'DAY',
      price: params.targetPrice.toFixed(2),
      quantity: String(params.quantity),
    });

    await this.request<ApiResponse>('/rest/secure/angelbroking/order/v1/placeOrder', 'POST', {
      variety: 'STOPLOSS',
      tradingsymbol: params.symbol,
      symboltoken: token,
      transactiontype: 'SELL',
      exchange: params.exchange,
      ordertype: 'STOPLOSS_LIMIT',
      producttype: 'DELIVERY',
      duration: 'DAY',
      price: params.stopPrice.toFixed(2),
      triggerprice: params.stopPrice.toFixed(2),
      quantity: String(params.quantity),
    });

    return {
      mode: 'limit_sl',
      orderId: buyRes.data?.orderid,
      note: 'LIMIT buy + target LIMIT sell + STOPLOSS_LIMIT on Angel One',
    };
  }

  private async request<T>(
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
    auth = true
  ): Promise<T> {
    const backoffsMs = [0, 45_000, 60_000, 90_000];

    for (let attempt = 0; attempt < backoffsMs.length; attempt += 1) {
      if (backoffsMs[attempt] > 0) {
        await sleep(backoffsMs[attempt]);
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
        'X-ClientLocalIP': this.creds.localIp ?? '127.0.0.1',
        'X-ClientPublicIP': this.creds.publicIp ?? '127.0.0.1',
        'X-MACAddress': '00:00:00:00:00:00',
        'X-PrivateKey': this.creds.apiKey,
      };

      if (auth) {
        if (!this.jwtToken) throw new Error('Not logged in to Angel One');
        headers.Authorization = `Bearer ${this.jwtToken}`;
      }

      const response = await fetch(`${BASE_URL}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      const text = await response.text();
      const rateLimited =
        response.status === 403 ||
        text.includes('exceeding access rate') ||
        text.includes('Too many requests');

      if (rateLimited && attempt < backoffsMs.length - 1) {
        continue;
      }

      if (rateLimited) {
        throw new Error(`Angel One API error (403): ${text.slice(0, 200)}`);
      }

      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(`Angel One API error (${response.status}): ${text.slice(0, 200)}`);
      }
    }

    throw new Error('Angel One API request failed after retries');
  }
}

function formatCandleDate(date: Date): string {
  const ist = formatIST(date).replace(' IST', '');
  return ist.slice(0, 16);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function loadAngelCredentials(): AngelOneCredentials {
  const apiKey = process.env.ANGEL_API_KEY?.trim();
  const clientId = process.env.ANGEL_CLIENT_ID?.trim();
  const password = process.env.ANGEL_PASSWORD?.trim();
  const totpSecret = process.env.ANGEL_TOTP_SECRET?.trim();

  if (!apiKey || !clientId || !password || !totpSecret) {
    throw new Error(
      'Missing Angel One credentials. Set ANGEL_API_KEY, ANGEL_CLIENT_ID, ANGEL_PASSWORD, ANGEL_TOTP_SECRET in .env'
    );
  }

  return {
    apiKey,
    clientId,
    password,
    totpSecret,
    localIp: process.env.ANGEL_LOCAL_IP?.trim(),
    publicIp: process.env.ANGEL_PUBLIC_IP?.trim(),
  };
}

export function todayKey(): string {
  return istDateKey(new Date());
}
