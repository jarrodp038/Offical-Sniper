import { PublicKey } from '@solana/web3.js';
import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import BN from 'bn.js';

export interface PositionRiskConfig {
  takeProfitPercent: number; // e.g. 50 = sell at +50%
  stopLossPercent: number; // e.g. 25 = sell at -25%
  trailingStopPercent: number; // e.g. 15 = sell when price drops 15% from peak (0 to disable)
  activateTrailingAt: number; // e.g. 20 = trail only after price is +20% from entry
}

export class Position {
  readonly mint: PublicKey;
  readonly mintKey: string;
  readonly poolKeys: LiquidityPoolKeysV4;
  readonly tokenAta: PublicKey;
  readonly entryPrice: number;
  readonly entryTimestamp: number;
  readonly entryQuoteAmount: BN;
  tokenAmount: BN;

  private peakPrice: number;
  private trailingActive: boolean = false;

  constructor(params: {
    mint: PublicKey;
    poolKeys: LiquidityPoolKeysV4;
    tokenAta: PublicKey;
    entryPrice: number;
    entryQuoteAmount: BN;
    tokenAmount: BN;
  }) {
    this.mint = params.mint;
    this.mintKey = params.mint.toBase58();
    this.poolKeys = params.poolKeys;
    this.tokenAta = params.tokenAta;
    this.entryPrice = params.entryPrice;
    this.entryQuoteAmount = params.entryQuoteAmount;
    this.tokenAmount = params.tokenAmount;
    this.entryTimestamp = Date.now();
    this.peakPrice = params.entryPrice;
  }

  pnlPercent(currentPrice: number): number {
    if (this.entryPrice === 0) return 0;
    return ((currentPrice - this.entryPrice) / this.entryPrice) * 100;
  }

  /**
   * Evaluate whether risk rules force an exit. Returns a reason string when
   * an exit should be triggered, otherwise null.
   */
  evaluateRisk(currentPrice: number, config: PositionRiskConfig): string | null {
    if (currentPrice <= 0) return null;

    const pnl = this.pnlPercent(currentPrice);

    if (currentPrice > this.peakPrice) {
      this.peakPrice = currentPrice;
    }

    if (!this.trailingActive && pnl >= config.activateTrailingAt) {
      this.trailingActive = true;
    }

    if (pnl >= config.takeProfitPercent) {
      return `Take profit hit (+${pnl.toFixed(2)}%)`;
    }

    if (pnl <= -config.stopLossPercent) {
      return `Stop loss hit (${pnl.toFixed(2)}%)`;
    }

    if (this.trailingActive && config.trailingStopPercent > 0) {
      const dropFromPeak = ((this.peakPrice - currentPrice) / this.peakPrice) * 100;
      if (dropFromPeak >= config.trailingStopPercent) {
        return `Trailing stop hit (-${dropFromPeak.toFixed(2)}% from peak)`;
      }
    }

    return null;
  }

  get peak(): number {
    return this.peakPrice;
  }

  get ageMs(): number {
    return Date.now() - this.entryTimestamp;
  }
}
