import { Candle } from './indicators';
import { logger } from '../helpers/logger';

const GT_API_BASE = 'https://api.geckoterminal.com/api/v2';
const MAX_LIMIT_PER_REQUEST = 1000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface BackfillOptions {
  poolAddress: string;
  symbol?: string;
  hours: number;
  network?: string;
}

interface OhlcvResponse {
  data?: {
    attributes?: {
      ohlcv_list?: number[][];
    };
  };
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch historical 1-minute OHLCV candles for a Solana DEX pool from
 * GeckoTerminal. Paginates backwards via `before_timestamp` until the
 * requested window is covered or the pool runs out of data (i.e. inception).
 *
 * Prices are requested in the quote token's denomination so they line up
 * with the live samplePrice() values produced from on-chain pool simulation.
 */
export async function backfillCandles(opts: BackfillOptions): Promise<Candle[]> {
  const { poolAddress, symbol, hours, network = 'solana' } = opts;
  const desiredCount = Math.max(1, Math.floor(hours * 60));

  const collected: Candle[] = [];
  let beforeTimestamp: number | undefined;
  let pages = 0;

  while (collected.length < desiredCount) {
    const remaining = desiredCount - collected.length;
    const limit = Math.min(remaining, MAX_LIMIT_PER_REQUEST);

    const url = new URL(`${GT_API_BASE}/networks/${network}/pools/${poolAddress}/ohlcv/minute`);
    url.searchParams.set('aggregate', '1');
    url.searchParams.set('limit', limit.toString());
    url.searchParams.set('currency', 'token');
    url.searchParams.set('token', 'base');
    if (beforeTimestamp) url.searchParams.set('before_timestamp', beforeTimestamp.toString());

    let res: Response;
    try {
      res = await fetchWithTimeout(url.toString(), REQUEST_TIMEOUT_MS);
    } catch (e: any) {
      logger.warn({ symbol, pool: poolAddress, error: e.message }, 'Historical fetch network error');
      break;
    }

    if (!res.ok) {
      logger.warn(
        { symbol, pool: poolAddress, status: res.status },
        'Historical fetch returned non-OK status',
      );
      break;
    }

    let json: OhlcvResponse;
    try {
      json = (await res.json()) as OhlcvResponse;
    } catch (e: any) {
      logger.warn({ symbol, pool: poolAddress, error: e.message }, 'Historical response not JSON');
      break;
    }

    const list = json?.data?.attributes?.ohlcv_list ?? [];
    if (list.length === 0) break;

    // GeckoTerminal returns rows newest -> oldest as [tsSec, open, high, low, close, volume].
    let oldestTsSec = Number.POSITIVE_INFINITY;
    for (const row of list) {
      const [tsSec, open, high, low, close, volume] = row;
      if (typeof tsSec !== 'number' || typeof close !== 'number') continue;
      collected.push({
        timestamp: tsSec * 1000,
        open: open ?? close,
        high: high ?? close,
        low: low ?? close,
        close,
        volume: volume ?? 0,
      });
      if (tsSec < oldestTsSec) oldestTsSec = tsSec;
    }

    pages++;
    if (list.length < limit) break; // upstream has nothing older — likely token inception
    beforeTimestamp = oldestTsSec - 1;
  }

  if (collected.length === 0) return [];

  collected.sort((a, b) => a.timestamp - b.timestamp);

  // Deduplicate any overlapping timestamps from pagination edges.
  const deduped: Candle[] = [];
  let lastTs = -1;
  for (const c of collected) {
    if (c.timestamp === lastTs) continue;
    deduped.push(c);
    lastTs = c.timestamp;
  }

  logger.info(
    { symbol, pool: poolAddress, candles: deduped.length, pages },
    'Historical candles fetched',
  );
  return deduped;
}
