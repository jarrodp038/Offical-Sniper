import { Connection } from '@solana/web3.js';
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
const MAX_CANDLES = 500;

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
  ): Promise<number> {
    try {
      const poolInfo = await Liquidity.fetchInfo({
        connection: this.connection,
        poolKeys,
      });

      const baseToken = new Token(
        TOKEN_PROGRAM_ID,
        poolKeys.baseMint,
        poolKeys.baseDecimals,
      );

      const amountOut = Liquidity.computeAmountOut({
        poolKeys,
        poolInfo,
        amountIn: new TokenAmount(quoteToken, sampleAmount),
        currencyOut: baseToken,
        slippage: new Percent(0, 100),
      });

      const baseAmount = parseFloat(amountOut.amountOut.toFixed());
      if (baseAmount === 0) return 0;

      const quoteAmount = parseFloat(new TokenAmount(quoteToken, sampleAmount).toFixed());
      return quoteAmount / baseAmount;
    } catch (e: any) {
      logger.debug({ error: e.message }, 'samplePrice failed');
      return 0;
    }
  }

  /**
   * Estimate volume by tracking changes in the pool's quote vault balance.
   * Each call returns the volume since the previous call.
   */
  async sampleVolume(poolKeys: LiquidityPoolKeysV4, mintKey: string): Promise<number> {
    try {
      const info = await this.connection.getAccountInfo(poolKeys.quoteVault);
      if (!info) return 0;
      const balance = info.data.readBigUInt64LE(64);

      const prev = this.lastVaultBalance.get(mintKey);
      this.lastVaultBalance.set(mintKey, balance);

      if (prev === undefined) return 0;

      const delta = balance > prev ? balance - prev : prev - balance;
      const scale = 10 ** poolKeys.quoteDecimals;
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

  reset(mintKey: string): void {
    this.history.delete(mintKey);
    this.inProgress.delete(mintKey);
    this.lastVaultBalance.delete(mintKey);
  }
}
