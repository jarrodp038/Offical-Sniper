import { Candle, IndicatorSnapshot, snapshotIndicators } from './indicators';

export type Action = 'BUY' | 'SELL' | 'HOLD';

export interface Signal {
  action: Action;
  confidence: number; // 0-100
  reasons: string[];
  indicators: IndicatorSnapshot;
}

export interface SignalConfig {
  rsiOversold: number;
  rsiOverbought: number;
  minConfidenceToBuy: number;
  minConfidenceToSell: number;
  minCandles: number;
}

export const DEFAULT_SIGNAL_CONFIG: SignalConfig = {
  rsiOversold: 30,
  rsiOverbought: 70,
  minConfidenceToBuy: 60,
  minConfidenceToSell: 55,
  minCandles: 30,
};

/**
 * Combine indicators into a BUY/SELL/HOLD signal with a confidence score.
 * Confidence is a weighted sum of signal points across multiple indicators.
 */
export function generateSignal(
  candles: Candle[],
  config: SignalConfig = DEFAULT_SIGNAL_CONFIG,
  holding: boolean = false,
): Signal {
  const indicators = snapshotIndicators(candles);

  // Warmup period — need enough data to produce reliable signals
  if (candles.length < config.minCandles) {
    return {
      action: 'HOLD',
      confidence: 0,
      reasons: [`Warming up (${candles.length}/${config.minCandles} candles)`],
      indicators,
    };
  }

  let bullScore = 0;
  let bearScore = 0;
  const reasons: string[] = [];

  // 1. RSI
  if (indicators.rsi !== null) {
    if (indicators.rsi < config.rsiOversold) {
      bullScore += 20;
      reasons.push(`RSI ${indicators.rsi.toFixed(1)} oversold`);
    } else if (indicators.rsi > config.rsiOverbought) {
      bearScore += 20;
      reasons.push(`RSI ${indicators.rsi.toFixed(1)} overbought`);
    } else if (indicators.rsi < 45) {
      bullScore += 5;
    } else if (indicators.rsi > 55) {
      bearScore += 5;
    }
  }

  // 2. EMA crossover
  if (indicators.emaFast !== null && indicators.emaSlow !== null) {
    if (indicators.emaFast > indicators.emaSlow) {
      bullScore += 15;
      reasons.push('EMA9 > EMA21 (bullish)');
    } else {
      bearScore += 15;
      reasons.push('EMA9 < EMA21 (bearish)');
    }
  }

  // 3. MACD histogram
  if (indicators.macdHistogram !== null) {
    if (indicators.macdHistogram > 0) {
      bullScore += 15;
      reasons.push(`MACD hist +${indicators.macdHistogram.toExponential(2)}`);
    } else {
      bearScore += 15;
      reasons.push(`MACD hist ${indicators.macdHistogram.toExponential(2)}`);
    }
  }

  // 4. Bollinger Bands
  if (
    indicators.bbLower !== null &&
    indicators.bbUpper !== null &&
    indicators.price > 0
  ) {
    if (indicators.price < indicators.bbLower) {
      bullScore += 15;
      reasons.push('Price below lower BB');
    } else if (indicators.price > indicators.bbUpper) {
      bearScore += 15;
      reasons.push('Price above upper BB');
    }
  }

  // 5. Price vs VWAP
  if (indicators.vwap !== null && indicators.price > 0) {
    if (indicators.price > indicators.vwap) {
      bullScore += 10;
      reasons.push('Price > VWAP');
    } else {
      bearScore += 10;
      reasons.push('Price < VWAP');
    }
  }

  // 6. Volume confirmation
  if (indicators.volumeRatio !== null) {
    if (indicators.volumeRatio > 1.5) {
      // Above average volume amplifies whichever side is leading
      if (bullScore > bearScore) {
        bullScore += 10;
        reasons.push(`Volume ${indicators.volumeRatio.toFixed(2)}x avg`);
      } else {
        bearScore += 10;
        reasons.push(`Volume ${indicators.volumeRatio.toFixed(2)}x avg`);
      }
    }
  }

  // 7. Trend confirmation
  if (indicators.trend === 'UP') {
    bullScore += 10;
    reasons.push('Trend: up');
  } else if (indicators.trend === 'DOWN') {
    bearScore += 10;
    reasons.push('Trend: down');
  }

  const totalScore = bullScore + bearScore;
  if (totalScore === 0) {
    return { action: 'HOLD', confidence: 0, reasons: ['No signal'], indicators };
  }

  const bullConfidence = (bullScore / totalScore) * 100;
  const bearConfidence = (bearScore / totalScore) * 100;

  // Determine action
  if (!holding && bullConfidence >= config.minConfidenceToBuy) {
    return {
      action: 'BUY',
      confidence: Math.round(bullConfidence),
      reasons,
      indicators,
    };
  }

  if (holding && bearConfidence >= config.minConfidenceToSell) {
    return {
      action: 'SELL',
      confidence: Math.round(bearConfidence),
      reasons,
      indicators,
    };
  }

  return {
    action: 'HOLD',
    confidence: Math.round(Math.max(bullConfidence, bearConfidence)),
    reasons,
    indicators,
  };
}
