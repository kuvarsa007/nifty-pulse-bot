import { loadConfig, displaySymbol } from './config';
import { BotLogger } from './logger';
import { createEngine } from './bot/engine';
import { MockMarketReplay } from './market/mockReplay';
import { AngelOneMarketData } from './market/angelOne';
import { runMarketScan, ScannerHardFail } from './scanner/runScan';
import { notifyScannerFail, notifyScannerWatchlist, sendTelegram } from './notify/telegram';

async function runMockDay(): Promise<void> {
  const config = loadConfig({ dryRun: true, useMockData: true });
  const logger = new BotLogger();
  const market = new MockMarketReplay();
  const engine = createEngine(market, logger, config);

  await engine.replayDay(market.getTicks());
  console.log(`\nLog file: ${logger.getLogFilePath()}`);
}

async function runAngelLiveSession(dryRun: boolean): Promise<void> {
  const config = loadConfig({ dryRun, useMockData: false });
  const logger = new BotLogger();
  const market = new AngelOneMarketData(config.exchange, config.candleRefreshSec);

  if (dryRun) {
    console.log(`Starting DRY_RUN with LIVE Angel One prices + WebSocket...`);
  } else {
    console.log('WARNING: LIVE mode — real bracket/SL orders will be placed on Angel One.');
  }

  try {
    await market.connect();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Angel One login failed: ${message}`);
    console.error('Check ANGEL_API_KEY, ANGEL_CLIENT_ID, ANGEL_PASSWORD, ANGEL_TOTP_SECRET in .env');
    process.exit(1);
  }

  const engine = createEngine(market, logger, config);

  // ─── Dynamic scanner (required when enabled) ─────────────────────────────
  const scanEnabled = process.env.SCANNER_ENABLED !== 'false';
  const allowEnvFallback = process.env.SCANNER_ALLOW_ENV_FALLBACK === 'true';

  if (scanEnabled) {
    console.log('\nRunning market scanner (liquid universe — NO silent .env fallback)...');
    try {
      const maxPrice = Math.floor(
        config.amountPerTrade / Math.max(config.minQuantity, 1)
      );
      const topMovers = await runMarketScan({
        topN: Math.max(config.maxOpenPositions + 2, 5),
        minGainFromOpenPct: Number(process.env.SCANNER_MIN_GAIN_PCT ?? 0.15),
        minVolume: Number(process.env.SCANNER_MIN_VOLUME ?? 10000),
        minPrice: Number(process.env.SCANNER_MIN_PRICE ?? 20),
        maxPrice: Number(process.env.SCANNER_MAX_PRICE ?? maxPrice),
        exchange: config.exchange,
        waitFor935IfEmpty: process.env.SCANNER_WAIT_935 !== 'false',
      });

      const dynamicWatchlist = topMovers.map((m) => m.symbol);
      engine.updateActiveWatchlist(dynamicWatchlist);
      const pretty = dynamicWatchlist.map(displaySymbol);
      console.log(`Scanner watchlist: ${pretty.join(', ')}`);
      notifyScannerWatchlist(pretty);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\nSCANNER HARD FAIL: ${message}`);
      notifyScannerFail(message);

      if (allowEnvFallback) {
        console.warn(
          `SCANNER_ALLOW_ENV_FALLBACK=true — using .env watchlist: ${config.watchlist
            .map(displaySymbol)
            .join(', ')}`
        );
        void sendTelegram(
          `Fallback watchlist (env): ${config.watchlist.map(displaySymbol).join(', ')}`
        );
      } else {
        console.error(
          'Refusing to trade a fixed watchlist. Fix scanner or set SCANNER_ALLOW_ENV_FALLBACK=true only if you really want that.'
        );
        process.exit(1);
      }
    }
  } else {
    console.log(
      `Scanner disabled. Watchlist from .env: ${config.watchlist.map(displaySymbol).join(', ')}`
    );
  }
  // ─────────────────────────────────────────────────────────────────────────

  const activeWatchlist = engine.getActiveWatchlist();
  if (activeWatchlist.length === 0) {
    console.error('No watchlist symbols — exiting.');
    process.exit(1);
  }

  if (market.prefetchSymbols) {
    console.log('\nPrefetching watchlist tokens...');
    try {
      await market.prefetchSymbols(activeWatchlist);
      console.log('Tokens ready.\n');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`Token prefetch warning: ${message}`);
    }
  }

  await engine.runLiveSession();
  console.log(`\nLog file: ${logger.getLogFilePath()}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mockDay = args.includes('--mock-day');
  const liveDryRun = args.includes('--live-dry-run');
  const liveTrading = args.includes('--live');

  if (mockDay) {
    await runMockDay();
    return;
  }

  if (liveTrading) {
    await runAngelLiveSession(false);
    return;
  }

  if (liveDryRun) {
    await runAngelLiveSession(true);
    return;
  }

  const config = loadConfig();
  if (config.useMockData) {
    await runMockDay();
    return;
  }

  if (config.dryRun) {
    await runAngelLiveSession(true);
    return;
  }

  await runAngelLiveSession(false);
}

main().catch((err) => {
  if (err instanceof ScannerHardFail) {
    console.error(`SCANNER HARD FAIL: ${err.message}`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
