/**
 * Instrument Master — downloads and caches the Angel One instrument list.
 *
 * Robust behaviour:
 *  - Prefer fresh cache (< 24h)
 *  - On download failure, reuse STALE cache (better than crashing)
 *  - Retries + timeout + non-200 handling
 */

import fs from 'fs';
import https from 'https';
import path from 'path';
import { LIQUID_NSE_EQ } from './liquidUniverse';

const MASTER_URL =
  'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';
const CACHE_FILE =
  process.env.INSTRUMENT_CACHE_PATH ??
  path.join(process.cwd(), '.instrument-master-cache.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const DOWNLOAD_RETRIES = 3;

export interface InstrumentEntry {
  token: string;
  symbol: string;
  name: string;
  exch_seg: string;
  lotsize: string;
  tick_size: string;
}

interface MasterCache {
  timestamp: number;
  entries: InstrumentEntry[];
}

export async function getNseEqMaps(verbose = false): Promise<{
  tokenToSymbol: Map<string, string>;
  symbolToToken: Map<string, string>;
  total: number;
}> {
  const entries = await loadMaster(verbose);
  const tokenToSymbol = new Map<string, string>();
  const symbolToToken = new Map<string, string>();

  for (const e of entries) {
    if (e.exch_seg !== 'NSE') continue;
    if (!e.symbol.endsWith('-EQ')) continue;
    if (e.symbol.startsWith('NIFTY') || e.symbol.startsWith('BANKNIFTY')) continue;

    tokenToSymbol.set(e.token, e.symbol);
    symbolToToken.set(e.symbol, e.token);
  }

  return { tokenToSymbol, symbolToToken, total: tokenToSymbol.size };
}

/**
 * Resolve liquid-universe symbols → tokens using the master maps.
 * Returns only symbols that exist in Angel One master.
 */
export function resolveLiquidTokens(
  symbolToToken: Map<string, string>,
  universe: string[] = LIQUID_NSE_EQ
): Map<string, string> {
  const tokenToSymbol = new Map<string, string>();
  for (const symbol of universe) {
    const token = symbolToToken.get(symbol);
    if (token) tokenToSymbol.set(token, symbol);
  }
  return tokenToSymbol;
}

async function loadMaster(verbose: boolean): Promise<InstrumentEntry[]> {
  const cached = readCache();
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    const ageMin = Math.round((Date.now() - cached.timestamp) / 60_000);
    if (verbose) {
      process.stdout.write(
        `  (using cached master — ${cached.entries.length} instruments, ${ageMin}m old)\n`
      );
    }
    return cached.entries;
  }

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt += 1) {
    try {
      if (verbose) {
        process.stdout.write(
          `  Downloading instrument master (attempt ${attempt}/${DOWNLOAD_RETRIES}) ...`
        );
      }
      const raw = await downloadJson(MASTER_URL);
      if (!Array.isArray(raw) || raw.length < 1000) {
        throw new Error(`Unexpected master payload (len=${Array.isArray(raw) ? raw.length : 0})`);
      }
      const entries = raw as InstrumentEntry[];
      if (verbose) process.stdout.write(` ${entries.length} instruments\n`);
      writeCache({ timestamp: Date.now(), entries });
      return entries;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (verbose) process.stdout.write(` FAILED: ${lastError.message}\n`);
      if (attempt < DOWNLOAD_RETRIES) await sleep(1500 * attempt);
    }
  }

  if (cached && cached.entries.length > 0) {
    const ageMin = Math.round((Date.now() - cached.timestamp) / 60_000);
    if (verbose) {
      process.stdout.write(
        `  WARNING: download failed — using STALE cache (${cached.entries.length} instruments, ${ageMin}m old)\n`
      );
      process.stdout.write(`  last error: ${lastError?.message ?? 'unknown'}\n`);
    }
    return cached.entries;
  }

  throw new Error(
    `Instrument master unavailable: ${lastError?.message ?? 'unknown'} (no local cache at ${CACHE_FILE})`
  );
}

function readCache(): MasterCache | null {
  if (!fs.existsSync(CACHE_FILE)) return null;
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const cached = JSON.parse(raw) as MasterCache;
    if (!cached?.entries?.length) return null;
    return cached;
  } catch {
    return null;
  }
}

function writeCache(data: MasterCache): void {
  const dir = path.dirname(CACHE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf8');
}

function downloadJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: DOWNLOAD_TIMEOUT_MS }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        downloadJson(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode ?? '??'} from instrument CDN`));
        return;
      }

      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          if (!text.trim()) {
            reject(new Error('Empty response from instrument CDN'));
            return;
          }
          resolve(JSON.parse(text));
        } catch {
          reject(new Error('Failed to parse instrument master JSON'));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Instrument CDN timeout after ${DOWNLOAD_TIMEOUT_MS}ms`));
    });
    req.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
