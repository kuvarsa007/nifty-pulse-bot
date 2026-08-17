/**
 * Standalone scanner — see today's liquid-universe top movers.
 *
 * Usage:
 *   npm run scan
 *   npm run scan -- 10
 */

import { displaySymbol } from '../config';
import { runMarketScan } from './runScan';

async function main(): Promise<void> {
  const topN = Number(process.argv[2] ?? 10);

  console.log('\n' + '='.repeat(68));
  console.log('  NSE MARKET SCANNER — Liquid Universe');
  console.log('='.repeat(68));
  console.log(`  Showing top ${topN} movers\n`);

  const results = await runMarketScan({
    topN,
    minGainFromOpenPct: Number(process.env.SCANNER_MIN_GAIN_PCT ?? 0.15),
    minVolume: Number(process.env.SCANNER_MIN_VOLUME ?? 10000),
    minPrice: Number(process.env.SCANNER_MIN_PRICE ?? 20),
    maxPrice: Number(process.env.SCANNER_MAX_PRICE ?? 2500),
    exchange: process.env.EXCHANGE ?? 'NSE',
    waitFor935IfEmpty: false,
  });

  console.log('Suggested watchlist:');
  console.log(`  ${results.map((r) => r.symbol).join(',')}`);
  console.log(`  (${results.map((r) => displaySymbol(r.symbol)).join(', ')})`);
  console.log('');
}

main().catch((err) => {
  console.error('\nScanner failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
