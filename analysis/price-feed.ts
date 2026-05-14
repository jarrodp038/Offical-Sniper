  import { Connection, PublicKey } from '@solana/web3.js';
import {
  Liquidity,
  LiquidityPoolKeysV4,
  Token,
  TokenAmount,
  Percent,
  TOKEN_PROGRAM_ID,
} from '@raydium-io/raydium-sdk';
import BN from 'bn.js';
import { Candle } from './indicators';
import { logger } from '../helpers/logger';

const CANDLE_INTERVAL_MS = 60_000; // 1-minute candles
const MAX_CANDLES = 10_000;

interface PartialCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  startedAt: number;
}

export class PriceFeed {
  private history: Map<string, Candle[]> = new Map();
  private inProgress: Map<string, PartialCandle> = new Map();
  private lastVaultBalance: Map<string, bigint> = new Map();

  constructor(private readonly connection: Connection) {}

  /**
   * Sample current pool price by simulating a small swap.
   * Works for any token with an active Raydium pool.
   */
  async samplePrice(
    poolKeys: LiquidityPoolKeysV4,
    quoteToken: Token,
    sampleAmount: BN,
    targetMint?: PublicKey,
  ): Promise<number> {
    try {
      const poolInfo = await Liquidity.fetchInfo({
        connection: this.connection,
        poolKeys,
      });

      const reversed = targetMint ? poolKeys.quoteMint.equals(targetMint) : false;
      const outMint = reversed ? poolKeys.quoteMint : poolKeys.baseMint;
      const outDecimals = reversed ? poolKeys.quoteDecimals : poolKeys.baseDecimals;

      const outToken = new Token(TOKEN_PROGRAM_ID, outMint, outDecimals);

      const amountOut = Liquidity.computeAmountOut({
        poolKeys,
        poolInfo,
        amountIn: new TokenAmount(quoteToken, sampleAmount),
        currencyOut: outToken,
        slippage: new Percent(0, 100),
      });

      const targetAmount = parseFloat(amountOut.amountOut.toFixed());
      if (targetAmount === 0) return 0;

      const quoteAmount = parseFloat(new TokenAmount(quoteToken, sampleAmount).toFixed());
      return quoteAmount / targetAmount;
    } catch (e: any) {
      logger.warn({ error: e.message, mint: (targetMint ?? poolKeys.baseMint).toBase58() }, 'samplePrice failed');
      return 0;
    }
  }

  async sampleVolume(poolKeys: LiquidityPoolKeysV4, mintKey: string, targetMint?: PublicKey): Promise<number> {
    try {
      const reversed = targetMint ? poolKeys.quoteMint.equals(targetMint) : false;
      const vault = reversed ? poolKeys.baseVault : poolKeys.quoteVault;
      const decimals = reversed ? poolKeys.baseDecimals : poolKeys.quoteDecimals;

      const info = await this.connection.getAccountInfo(vault);
      if (!info) return 0;
      const balance = info.data.readBigUInt64LE(64);

      const prev = this.lastVaultBalance.get(mintKey);
      this.lastVaultBalance.set(mintKey, balance);

      if (prev === undefined) return 0;

      const delta = balance > prev ? balance - prev : prev - balance;
      const scale = 10 ** decimals;
      return Number(delta) / scale;
    } catch {
      return 0;
    }
  }

  /**
   * Push a new price observation. Updates the in-progress candle or rolls
   * it over into history when the interval elapses.
   */
  recordPrice(mintKey: string, price: number, volume: number = 0): void {
    if (price <= 0) return;

    const now = Date.now();
    let partial = this.inProgress.get(mintKey);

    if (!partial) {
      partial = { open: price, high: price, low: price, close: price, volume, startedAt: now };
      this.inProgress.set(mintKey, partial);
      return;
    }

    // Roll over completed candle
    if (now - partial.startedAt >= CANDLE_INTERVAL_MS) {
      const candles = this.history.get(mintKey) ?? [];
      candles.push({
        open: partial.open,
        high: partial.high,
        low: partial.low,
        close: partial.close,
        volume: partial.volume,
        timestamp: partial.startedAt,
      });
      if (candles.length > MAX_CANDLES) {
        candles.splice(0, candles.length - MAX_CANDLES);
      }
      this.history.set(mintKey, candles);

      this.inProgress.set(mintKey, {
        open: price,
        high: price,
        low: price,
        close: price,
        volume,
        startedAt: now,
      });
      return;
    }

    partial.close = price;
    if (price > partial.high) partial.high = price;
    if (price < partial.low) partial.low = price;
    partial.volume += volume;
  }

  /**
   * Return candles including the in-progress one (so indicators reflect
   * current price even before the interval rolls over).
   */
  getCandles(mintKey: string): Candle[] {
    const history = this.history.get(mintKey) ?? [];
    const partial = this.inProgress.get(mintKey);

    if (!partial) return history;

    return [
      ...history,
      {
        open: partial.open,
        high: partial.high,
        low: partial.low,
        close: partial.close,
        volume: partial.volume,
        timestamp: partial.startedAt,
      },
    ];
  }

  getCandleCount(mintKey: string): number {
    return (this.history.get(mintKey)?.length ?? 0) + (this.inProgress.has(mintKey) ? 1 : 0);
  }

  /**
   * Seed completed-candle history from an external source (e.g. GeckoTerminal
   * backfill). Replaces any existing stored history for the mint. The list
   * should already be sorted oldest -> newest.
   */
  seedHistory(mintKey: string, candles: Candle[]): void {
    if (candles.length === 0) return;
    const trimmed = candles.length > MAX_CANDLES ? candles.slice(-MAX_CANDLES) : candles.slice();
    this.history.set(mintKey, trimmed);
  }

  /**
   * Rescale seeded history so its most recent close matches a live price
   * sample. Indicators are largely scale-invariant but absolute-price
   * indicators (Bollinger Bands, VWAP) and the continuity into live data
   * benefit from a consistent unit. No-op when the scale already matches.
   */
  normalizeHistoryTo(mintKey: string, livePrice: number): number | null {
    const history = this.history.get(mintKey);
    if (!history || history.length === 0 || livePrice <= 0) return null;
    const lastClose = history[history.length - 1].close;
    if (lastClose <= 0) return null;
    const ratio = livePrice / lastClose;
    if (Math.abs(ratio - 1) < 0.05) return ratio;
    for (const c of history) {
      c.open *= ratio;
      c.high *= ratio;
      c.low *= ratio;
      c.close *= ratio;
    }
    return ratio;
  }

  reset(mintKey: string): void {
    this.history.delete(mintKey);
    this.inProgress.delete(mintKey);
    this.lastVaultBalance.delete(mintKey);
  }
}
