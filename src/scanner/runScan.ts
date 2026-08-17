/**
 * Orchestrates a real morning scan:
 *  1) load instrument master (stale cache OK)
 *  2) resolve liquid universe tokens
 *  3) scan with progressive filter relaxation
 *  4) if empty and still early, wait until ~09:35 IST and rescan once
 *  5) NEVER silently fall back to a fixed .env watchlist
 */

import { AngelOneClient, loadAngelCredentials } from '../market/angelOneClient';
import { getNseEqMaps, resolveLiquidTokens } from './instrumentMaster';
import {
  printScanResults,
  scanWithRelaxation,
  ScanOutcome,
  ScanResult,
} from './marketScanner';
import { LIQUID_NSE_EQ } from './liquidUniverse';

export interface RunScanOptions {
  topN: number;
  minGainFromOpenPct: number;
  minVolume: number;
  minPrice: number;
  maxPrice: number;
  exchange: string;
  /** Wait for 09:35 IST and retry once if first scan is empty (default true). */
  waitFor935IfEmpty?: boolean;
}

export class ScannerHardFail extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScannerHardFail';
  }
}

function istParts(d = new Date()): { h: number; m: number } {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(d);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return { h, m };
}

function msUntilIst(hour: number, minute: number): number {
  const now = Date.now();
  // Approximate: build target as offset from current IST clock
  const { h, m } = istParts();
  const nowMin = h * 60 + m;
  const targetMin = hour * 60 + minute;
  let diffMin = targetMin - nowMin;
  if (diffMin <= 0) return 0;
  // add seconds leftover roughly
  return diffMin * 60_000;
}

async function oneScan(client: AngelOneClient, opts: RunScanOptions): Promise<ScanOutcome> {
  console.log('Loading instrument master...');
  const { symbolToToken, total } = await getNseEqMaps(true);
  console.log(`  ${total} NSE EQ stocks in master`);

  const tokenToSymbol = resolveLiquidTokens(symbolToToken, LIQUID_NSE_EQ);
  console.log(`  Liquid universe resolved: ${tokenToSymbol.size}/${LIQUID_NSE_EQ.length} symbols`);

  if (tokenToSymbol.size < 20) {
    throw new ScannerHardFail(
      `Only ${tokenToSymbol.size} liquid symbols resolved — instrument master looks broken`
    );
  }

  return scanWithRelaxation(
    client,
    tokenToSymbol,
    {
      minGainFromOpenPct: opts.minGainFromOpenPct,
      minVolume: opts.minVolume,
      minPrice: opts.minPrice,
      maxPrice: opts.maxPrice,
      exchange: opts.exchange,
    },
    opts.topN
  );
}

/**
 * Returns today's scanner watchlist symbols.
 * Throws ScannerHardFail if no movers can be found (caller must NOT use .env fallback).
 */
export async function runMarketScan(opts: RunScanOptions): Promise<ScanResult[]> {
  const client = new AngelOneClient(loadAngelCredentials());
  await client.login();
  console.log('Scanner Angel One login OK.');

  let outcome = await oneScan(client, opts);

  if (outcome.results.length === 0 && (opts.waitFor935IfEmpty ?? true)) {
    const waitMs = msUntilIst(9, 35);
    if (waitMs > 0 && waitMs < 25 * 60_000) {
      console.log(
        `\nNo movers yet — waiting ${Math.ceil(waitMs / 1000)}s until ~09:35 IST for volume to build, then rescanning...`
      );
      await sleep(waitMs);
      console.log('\nRescan after 09:35 IST...');
      outcome = await oneScan(client, {
        ...opts,
        minGainFromOpenPct: Math.min(opts.minGainFromOpenPct, 0.1),
        minVolume: Math.min(opts.minVolume, 8_000),
      });
    }
  }

  if (outcome.results.length === 0) {
    const s = outcome.stats;
    throw new ScannerHardFail(
      `Scanner found 0 movers after retries. ` +
        `quotes=${s.quotesReceived}/${s.tokensScanned} batchFail=${s.batchFailures} ` +
        `priceCut=${s.skippedPrice} volCut=${s.skippedVolume} gainCut=${s.skippedGain} ` +
        `zeroVol=${s.zeroVolumeQuotes} volOk=${s.volumeDataOk}. ` +
        `Refusing to use a fixed watchlist.`
    );
  }

  console.log('\nTop movers found:');
  printScanResults(outcome.results);
  return outcome.results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
