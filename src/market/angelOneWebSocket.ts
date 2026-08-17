import WebSocket from 'ws';
import { AngelOneSession } from './angelOneClient';

const WS_URL = 'wss://smartapisocket.angelone.in/smart-stream';
const PING_MS = 30_000;

export type LtpTickHandler = (ltp: number, at: Date, token: string) => void;

export function parseLtpFromBinary(message: WebSocket.RawData): number | null {
  const buf = Buffer.isBuffer(message) ? message : Buffer.from(message as ArrayBuffer);

  if (buf.length === 4 && buf.toString() === 'pong') return null;
  if (buf.length < 47) return null;

  const ltpPaise = buf.readInt32LE(43);
  if (!Number.isFinite(ltpPaise) || ltpPaise <= 0) return null;

  return ltpPaise / 100;
}

export function parseTokenFromBinary(message: WebSocket.RawData): string | null {
  const buf = Buffer.isBuffer(message) ? message : Buffer.from(message as ArrayBuffer);
  if (buf.length < 47) return null;

  let end = 2;
  while (end < 25 && buf[end] !== 0) end += 1;
  const token = buf.slice(2, end).toString('ascii').trim();
  return token || null;
}

export class AngelOneWebSocket {
  private session: AngelOneSession;
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private onTick: LtpTickHandler;
  private subscribedTokens: string[] = [];

  constructor(session: AngelOneSession, onTick: LtpTickHandler) {
    this.session = session;
    this.onTick = onTick;
  }

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    await new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(WS_URL, {
        headers: {
          Authorization: `Bearer ${this.session.jwtToken}`,
          'x-api-key': this.session.apiKey,
          'x-client-code': this.session.clientId,
          'x-feed-token': this.session.feedToken,
        },
      });

      this.ws.once('open', () => resolve());
      this.ws.once('error', (err) => reject(err));
    });

    const ws = this.ws;
    if (!ws) throw new Error('WebSocket failed to initialize');

    ws.on('message', (message) => {
      const ltp = parseLtpFromBinary(message);
      if (ltp === null) return;
      const token = parseTokenFromBinary(message) ?? '';
      this.onTick(ltp, new Date(), token);
    });

    ws.on('close', () => {
      this.stopPing();
    });

    this.startPing();
  }

  subscribeLtp(exchangeType: number, tokens: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    this.subscribedTokens = tokens;
    const payload = {
      action: 1,
      params: {
        mode: 1,
        tokenList: [{ exchangeType, tokens }],
      },
    };

    this.ws.send(JSON.stringify(payload));
  }

  disconnect(): void {
    this.stopPing();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send('ping');
      }
    }, PING_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

export function exchangeTypeCode(exchange: string): number {
  switch (exchange.toUpperCase()) {
    case 'NSE':
      return 1;
    case 'NFO':
      return 2;
    case 'BSE':
      return 3;
    case 'BFO':
      return 4;
    default:
      return 1;
  }
}
