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

type Direction = 'bull' | 'bear' | 'neutral';

interface ScoredSignal {
  name: string;
  direction: Direction;
  strength: number; // 0-1, how strong the signal is
  weight: number;   // importance of this indicator
  reason: string;
}

export function generateSignal(
  candles: Candle[],
  config: SignalConfig = DEFAULT_SIGNAL_CONFIG,
  holding: boolean = false,
): Signal {
  const indicators = snapshotIndicators(candles);

  if (candles.length < config.minCandles) {
    return {
      action: 'HOLD',
      confidence: 0,
      reasons: [`Warming up (${candles.length}/${config.minCandles} candles)`],
      indicators,
    };
  }

  const signals: ScoredSignal[] = [];

  // ── 1. RSI ──────────────────────────────────────────────────────
  if (indicators.rsi !== null) {
    if (indicators.rsi < config.rsiOversold) {
      signals.push({
        name: 'RSI', direction: 'bull', weight: 20,
        strength: Math.min(1, (config.rsiOversold - indicators.rsi) / 15),
        reason: `RSI ${indicators.rsi.toFixed(1)} oversold`,
      });
    } else if (indicators.rsi > config.rsiOverbought) {
      signals.push({
        name: 'RSI', direction: 'bear', weight: 20,
        strength: Math.min(1, (indicators.rsi - config.rsiOverbought) / 15),
        reason: `RSI ${indicators.rsi.toFixed(1)} overbought`,
      });
    } else if (indicators.rsi < 40) {
      signals.push({
        name: 'RSI', direction: 'bull', weight: 20,
        strength: 0.25,
        reason: `RSI ${indicators.rsi.toFixed(1)} leaning bullish`,
      });
    } else if (indicators.rsi > 60) {
      signals.push({
        name: 'RSI', direction: 'bear', weight: 20,
        strength: 0.25,
        reason: `RSI ${indicators.rsi.toFixed(1)} leaning bearish`,
      });
    } else {
      signals.push({ name: 'RSI', direction: 'neutral', weight: 20, strength: 0, reason: '' });
    }
  }

  // ── 2. EMA crossover + gap strength ─────────────────────────────
  if (indicators.emaFast !== null && indicators.emaSlow !== null && indicators.emaSlow !== 0) {
    const gap = (indicators.emaFast - indicators.emaSlow) / Math.abs(indicators.emaSlow);
    if (gap > 0) {
      const strength = Math.min(1, gap / 0.03);
      signals.push({
        name: 'EMA', direction: 'bull', weight: 15,
        strength,
        reason: `EMA9 > EMA21 by ${(gap * 100).toFixed(2)}%`,
      });
    } else {
      const strength = Math.min(1, Math.abs(gap) / 0.03);
      signals.push({
        name: 'EMA', direction: 'bear', weight: 15,
        strength,
        reason: `EMA9 < EMA21 by ${(Math.abs(gap) * 100).toFixed(2)}%`,
      });
    }
  }

  // ── 3. MACD histogram + momentum direction ──────────────────────
  if (indicators.macdHistogram !== null) {
    const hist = indicators.macdHistogram;
    const prevHist = indicators.macdHistPrev;
    const momentumBuilding = prevHist !== null
      ? (hist > 0 && hist > prevHist) || (hist < 0 && hist > prevHist)
      : false;
    const momentumFading = prevHist !== null
      ? (hist > 0 && hist < prevHist) || (hist < 0 && hist < prevHist)
      : false;

    if (hist > 0) {
      const strength = momentumBuilding ? 1 : momentumFading ? 0.3 : 0.6;
      const label = momentumBuilding ? 'rising' : momentumFading ? 'fading' : 'positive';
      signals.push({
        name: 'MACD', direction: 'bull', weight: 15,
        strength,
        reason: `MACD hist ${label}`,
      });
    } else {
      const strength = momentumFading ? 1 : momentumBuilding ? 0.3 : 0.6;
      const label = momentumFading ? 'falling' : momentumBuilding ? 'recovering' : 'negative';
      signals.push({
        name: 'MACD', direction: 'bear', weight: 15,
        strength,
        reason: `MACD hist ${label}`,
      });
    }
  }

  // ── 4. Bollinger Bands ──────────────────────────────────────────
  if (indicators.bbLower !== null && indicators.bbUpper !== null && indicators.bbMiddle !== null && indicators.price > 0) {
    if (indicators.price < indicators.bbLower) {
      signals.push({
        name: 'BB', direction: 'bull', weight: 15,
        strength: 1,
        reason: 'Price below lower BB',
      });
    } else if (indicators.price > indicators.bbUpper) {
      signals.push({
        name: 'BB', direction: 'bear', weight: 15,
        strength: 1,
        reason: 'Price above upper BB',
      });
    } else if (indicators.price < indicators.bbMiddle) {
      signals.push({
        name: 'BB', direction: 'bull', weight: 15,
        strength: 0.25,
        reason: 'Price below BB midline',
      });
    } else {
      signals.push({
        name: 'BB', direction: 'bear', weight: 15,
        strength: 0.25,
        reason: 'Price above BB midline',
      });
    }
  }

  // ── 5. Multi-timeframe trend alignment ──────────────────────────
  const trends = [indicators.trend, indicators.trend5m, indicators.trend15m, indicators.trend1h];
  const upCount = trends.filter((t) => t === 'UP').length;
  const downCount = trends.filter((t) => t === 'DOWN').length;

  if (upCount >= 3) {
    signals.push({
      name: 'MTF', direction: 'bull', weight: 20,
      strength: upCount === 4 ? 1 : 0.7,
      reason: `${upCount}/4 timeframes UP`,
    });
  } else if (upCount >= 2) {
    signals.push({
      name: 'MTF', direction: 'bull', weight: 20,
      strength: 0.35,
      reason: `${upCount}/4 timeframes UP`,
    });
  } else if (downCount >= 3) {
    signals.push({
      name: 'MTF', direction: 'bear', weight: 20,
      strength: downCount === 4 ? 1 : 0.7,
      reason: `${downCount}/4 timeframes DOWN`,
    });
  } else if (downCount >= 2) {
    signals.push({
      name: 'MTF', direction: 'bear', weight: 20,
      strength: 0.35,
      reason: `${downCount}/4 timeframes DOWN`,
    });
  } else {
    signals.push({
      name: 'MTF', direction: 'neutral', weight: 20,
      strength: 0,
      reason: 'Mixed timeframe trends',
    });
  }

  // ── 6. Price vs VWAP ───────────────────────────────────────────
  if (indicators.vwap !== null && indicators.vwap !== 0 && indicators.price > 0) {
    const dist = (indicators.price - indicators.vwap) / Math.abs(indicators.vwap);
    if (Math.abs(dist) > 0.005) {
      const strength = Math.min(1, Math.abs(dist) / 0.05);
      signals.push({
        name: 'VWAP', direction: dist > 0 ? 'bull' : 'bear', weight: 10,
        strength,
        reason: `Price ${dist > 0 ? 'above' : 'below'} VWAP by ${(Math.abs(dist) * 100).toFixed(1)}%`,
      });
    } else {
      signals.push({ name: 'VWAP', direction: 'neutral', weight: 10, strength: 0, reason: '' });
    }
  }

  // ── 7. Volume confirmation ─────────────────────────────────────
  if (indicators.volumeRatio !== null && indicators.volumeRatio > 1.5) {
    const bullWt = signals.filter((s) => s.direction === 'bull').reduce((sum, s) => sum + s.strength * s.weight, 0);
    const bearWt = signals.filter((s) => s.direction === 'bear').reduce((sum, s) => sum + s.strength * s.weight, 0);
    const volStrength = Math.min(1, (indicators.volumeRatio - 1) / 3);
    signals.push({
      name: 'VOL', direction: bullWt >= bearWt ? 'bull' : 'bear', weight: 5,
      strength: volStrength,
      reason: `Volume ${indicators.volumeRatio.toFixed(1)}x avg`,
    });
  }

  // ── Score calculation (absolute, not relative) ──────────────────
  const maxPossible = signals.reduce((sum, s) => sum + s.weight, 0);
  if (maxPossible === 0) {
    return { action: 'HOLD', confidence: 0, reasons: ['No indicators'], indicators };
  }

  const bullScore = signals
    .filter((s) => s.direction === 'bull')
    .reduce((sum, s) => sum + s.strength * s.weight, 0);
  const bearScore = signals
    .filter((s) => s.direction === 'bear')
    .reduce((sum, s) => sum + s.strength * s.weight, 0);

  const bullConfidence = Math.round((bullScore / maxPossible) * 100);
  const bearConfidence = Math.round((bearScore / maxPossible) * 100);

  const bullConfirming = signals.filter((s) => s.direction === 'bull' && s.strength >= 0.3).length;
  const bearConfirming = signals.filter((s) => s.direction === 'bear' && s.strength >= 0.3).length;

  const reasons = signals
    .filter((s) => s.reason.length > 0 && s.strength >= 0.25)
    .map((s) => s.reason);

  // ── Decision logic ──────────────────────────────────────────────

  // BUY: need high confidence + at least 3 confirming indicators +
  // multi-timeframe must not be strongly against us
  if (
    !holding &&
    bullConfidence >= config.minConfidenceToBuy &&
    bullConfirming >= 3 &&
    downCount < 3
  ) {
    return { action: 'BUY', confidence: bullConfidence, reasons, indicators };
  }

  // SELL when holding: bearish confidence + enough confirming signals
  if (holding && bearConfidence >= config.minConfidenceToSell && bearConfirming >= 3) {
    return { action: 'SELL', confidence: bearConfidence, reasons, indicators };
  }

  // SELL override: if 3+ timeframes are down, exit with lower threshold
  if (holding && downCount >= 3 && bearConfidence >= 30) {
    reasons.push('Multi-timeframe bearish override');
    return { action: 'SELL', confidence: bearConfidence, reasons, indicators };
  }

  return {
    action: 'HOLD',
    confidence: Math.max(bullConfidence, bearConfidence),
    reasons,
    indicators,
  };
}
