/**
 * Market Scanner — scans a liquid NSE universe and ranks top movers.
 *
 * Uses quote mode FULL so we get tradeVolume (OHLC mode often returns volume=0).
 */

import { AngelOneClient, BulkQuoteEntry } from '../market/angelOneClient';

export interface ScanResult {
  symbol: string;
  token: string;
  ltp: number;
  open: number;
  prevClose: number;
  volume: number;
  gainFromOpenPct: number;
  gapFromPrevClosePct: number;
  score: number;
}

export interface ScanFilterStats {
  tokensScanned: number;
  quotesReceived: number;
  batchFailures: number;
  skippedBadOhlc: number;
  skippedPrice: number;
  skippedVolume: number;
  skippedGain: number;
  passed: number;
  volumeDataOk: boolean;
  zeroVolumeQuotes: number;
}

export interface ScanOutcome {
  results: ScanResult[];
  stats: ScanFilterStats;
}

export interface ScannerConfig {
  topN: number;
  minGainFromOpenPct: number;
  minVolume: number;
  minPrice: number;
  maxPrice: number;
  batchSize: number;
  batchDelayMs: number;
  batchRetries: number;
  exchange: string;
  /** Prefer FULL — has tradeVolume. */
  quoteMode: 'OHLC' | 'FULL';
}

export const DEFAULT_SCANNER_CONFIG: ScannerConfig = {
  topN: 5,
  minGainFromOpenPct: 0.15,
  minVolume: 10_000,
  minPrice: 20,
  maxPrice: 2_500,
  batchSize: 50,
  batchDelayMs: 450,
  batchRetries: 2,
  exchange: 'NSE',
  quoteMode: 'FULL',
};

/** Angel One FULL uses tradeVolume; OHLC often leaves volume empty/0. */
export function quoteVolume(q: BulkQuoteEntry): number {
  const raw = q.tradeVolume ?? q.volume ?? 0;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function quoteGainFromOpenPct(q: BulkQuoteEntry): number {
  if (q.open > 0 && q.ltp > 0) {
    return ((q.ltp - q.open) / q.open) * 100;
  }
  const pct = q.percentChange;
  if (pct !== undefined && pct !== null && pct !== '') {
    const n = typeof pct === 'string' ? Number(pct) : pct;
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

export async function scanTopMovers(
  client: AngelOneClient,
  tokenToSymbol: Map<string, string>,
  cfg: Partial<ScannerConfig> = {}
): Promise<ScanOutcome> {
  const config: ScannerConfig = { ...DEFAULT_SCANNER_CONFIG, ...cfg };
  const allTokens = [...tokenToSymbol.keys()];
  const totalBatches = Math.ceil(allTokens.length / config.batchSize) || 0;

  const stats: ScanFilterStats = {
    tokensScanned: allTokens.length,
    quotesReceived: 0,
    batchFailures: 0,
    skippedBadOhlc: 0,
    skippedPrice: 0,
    skippedVolume: 0,
    skippedGain: 0,
    passed: 0,
    volumeDataOk: true,
    zeroVolumeQuotes: 0,
  };

  // First collect all usable quotes, then decide if volume filter is trustworthy.
  type Row = {
    symbol: string;
    token: string;
    ltp: number;
    open: number;
    prevClose: number;
    volume: number;
    gainFromOpenPct: number;
    gapFromPrevClosePct: number;
  };
  const candidates: Row[] = [];

  process.stdout.write(
    `  Scanning ${allTokens.length} liquid NSE stocks in ${totalBatches} batches (${config.quoteMode})`
  );

  for (let b = 0; b < totalBatches; b += 1) {
    const batch = allTokens.slice(b * config.batchSize, (b + 1) * config.batchSize);
    process.stdout.write('.');

    let quotes: BulkQuoteEntry[] | null = null;
    let lastErr: string | null = null;

    for (let attempt = 0; attempt <= config.batchRetries; attempt += 1) {
      try {
        quotes = await client.getBulkQuotes({ [config.exchange]: batch }, config.quoteMode);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        if (attempt < config.batchRetries) await sleep(600 * (attempt + 1));
      }
    }

    if (!quotes) {
      stats.batchFailures += 1;
      process.stdout.write('x');
      if (lastErr) {
        // continue other batches
      }
      if (b < totalBatches - 1) await sleep(config.batchDelayMs);
      continue;
    }

    stats.quotesReceived += quotes.length;

    for (const q of quotes) {
      if (!q.open || q.open <= 0 || !q.ltp || q.ltp <= 0) {
        stats.skippedBadOhlc += 1;
        continue;
      }
      if (q.ltp < config.minPrice || q.ltp > config.maxPrice) {
        stats.skippedPrice += 1;
        continue;
      }

      const volume = quoteVolume(q);
      if (volume <= 0) stats.zeroVolumeQuotes += 1;

      const gainFromOpenPct = quoteGainFromOpenPct(q);
      const symbol = tokenToSymbol.get(String(q.symbolToken)) ?? q.tradingSymbol;
      if (!symbol) continue;

      const gapFromPrevClosePct =
        q.close > 0 ? ((q.open - q.close) / q.close) * 100 : 0;

      candidates.push({
        symbol,
        token: String(q.symbolToken),
        ltp: q.ltp,
        open: q.open,
        prevClose: q.close,
        volume,
        gainFromOpenPct,
        gapFromPrevClosePct,
      });
    }

    if (b < totalBatches - 1) await sleep(config.batchDelayMs);
  }

  process.stdout.write(' done\n');

  // If most in-range quotes have zero volume, OHLC-style empty volume — don't block on vol.
  const pricedOk = candidates.length;
  const zeroShare = pricedOk > 0 ? stats.zeroVolumeQuotes / pricedOk : 1;
  stats.volumeDataOk = zeroShare < 0.5;
  if (!stats.volumeDataOk) {
    console.log(
      `  WARNING: volume missing on ${stats.zeroVolumeQuotes}/${pricedOk} quotes — ranking by gain% only (skip minVolume)`
    );
  }

  const results: ScanResult[] = [];
  for (const c of candidates) {
    if (stats.volumeDataOk && c.volume < config.minVolume) {
      stats.skippedVolume += 1;
      continue;
    }
    if (c.gainFromOpenPct < config.minGainFromOpenPct) {
      stats.skippedGain += 1;
      continue;
    }

    const score = stats.volumeDataOk
      ? c.gainFromOpenPct * Math.log10(Math.max(c.volume, 1))
      : c.gainFromOpenPct;

    stats.passed += 1;
    results.push({ ...c, score });
  }

  printFilterStats(stats, config);

  results.sort((a, b) => b.score - a.score);
  return { results: results.slice(0, config.topN), stats };
}

export async function scanWithRelaxation(
  client: AngelOneClient,
  tokenToSymbol: Map<string, string>,
  base: Partial<ScannerConfig>,
  topN: number
): Promise<ScanOutcome> {
  const passes: Partial<ScannerConfig>[] = [
    {
      ...base,
      topN,
      quoteMode: 'FULL',
      minGainFromOpenPct: base.minGainFromOpenPct ?? 0.15,
      minVolume: base.minVolume ?? 10_000,
    },
    { ...base, topN, quoteMode: 'FULL', minGainFromOpenPct: 0.05, minVolume: 5_000 },
    { ...base, topN, quoteMode: 'FULL', minGainFromOpenPct: 0.01, minVolume: 0 },
  ];

  let last: ScanOutcome = {
    results: [],
    stats: {
      tokensScanned: 0,
      quotesReceived: 0,
      batchFailures: 0,
      skippedBadOhlc: 0,
      skippedPrice: 0,
      skippedVolume: 0,
      skippedGain: 0,
      passed: 0,
      volumeDataOk: true,
      zeroVolumeQuotes: 0,
    },
  };

  for (let i = 0; i < passes.length; i += 1) {
    const p = passes[i];
    console.log(
      `  Scan pass ${i + 1}/${passes.length} (FULL gain≥${p.minGainFromOpenPct}% vol≥${p.minVolume})`
    );
    last = await scanTopMovers(client, tokenToSymbol, p);
    if (last.results.length > 0) {
      if (i > 0) console.log(`  Accepted after relaxing filters (pass ${i + 1})`);
      return last;
    }
    if (last.stats.quotesReceived === 0 && last.stats.batchFailures > 0) {
      break;
    }
  }

  return last;
}

export function printFilterStats(stats: ScanFilterStats, config: ScannerConfig): void {
  console.log(
    `  Filter stats: quotes=${stats.quotesReceived}/${stats.tokensScanned}` +
      ` pricedOk=${stats.quotesReceived - stats.skippedBadOhlc - stats.skippedPrice}` +
      ` passed=${stats.passed}` +
      ` badOhlc=${stats.skippedBadOhlc}` +
      ` price=${stats.skippedPrice}` +
      ` vol=${stats.skippedVolume}` +
      ` gain=${stats.skippedGain}` +
      ` zeroVol=${stats.zeroVolumeQuotes}` +
      ` volOk=${stats.volumeDataOk}` +
      ` batchFail=${stats.batchFailures}` +
      ` (need gain≥${config.minGainFromOpenPct}% vol≥${config.minVolume} price ${config.minPrice}-${config.maxPrice})`
  );
}

export function printScanResults(results: ScanResult[]): void {
  if (results.length === 0) {
    console.log('  No movers passed filters.');
    return;
  }

  console.log('');
  console.log('  Rank  Symbol          LTP       Open      Gain%   Volume     Score');
  console.log('  ' + '─'.repeat(70));

  results.forEach((r, i) => {
    const sym = r.symbol.replace('-EQ', '').padEnd(14);
    const ltp = `₹${r.ltp.toFixed(2)}`.padStart(10);
    const open = `₹${r.open.toFixed(2)}`.padStart(10);
    const gain = `${r.gainFromOpenPct >= 0 ? '+' : ''}${r.gainFromOpenPct.toFixed(2)}%`.padStart(8);
    const vol = formatVol(r.volume).padStart(10);
    const score = r.score.toFixed(1).padStart(7);
    console.log(`  ${String(i + 1).padStart(2)}.   ${sym} ${ltp} ${open} ${gain} ${vol} ${score}`);
  });

  console.log('');
}

function formatVol(v: number): string {
  if (v <= 0) return 'n/a';
  if (v >= 10_000_000) return `${(v / 1_000_000).toFixed(1)}Cr`;
  if (v >= 100_000) return `${(v / 100_000).toFixed(1)}L`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
  return String(v);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
