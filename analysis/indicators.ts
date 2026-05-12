export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}

export interface IndicatorSnapshot {
  price: number;
  rsi: number | null;
  emaFast: number | null;
  emaSlow: number | null;
  macdLine: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  vwap: number | null;
  bbUpper: number | null;
  bbMiddle: number | null;
  bbLower: number | null;
  atr: number | null;
  volumeRatio: number | null;
  trend: 'UP' | 'DOWN' | 'SIDEWAYS' | 'UNKNOWN';
}

export function calculateEMA(values: number[], period: number): number[] {
  if (values.length < period) return [];

  const multiplier = 2 / (period + 1);
  const ema: number[] = [];

  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  ema.push(sum / period);

  for (let i = period; i < values.length; i++) {
    ema.push((values[i] - ema[ema.length - 1]) * multiplier + ema[ema.length - 1]);
  }

  return ema;
}

export function calculateRSI(closes: number[], period: number = 14): number | null {
  if (closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) {
      avgGain = (avgGain * (period - 1) + change) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(change)) / period;
    }
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function calculateMACD(
  closes: number[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9,
): { macdLine: number | null; signal: number | null; histogram: number | null } {
  if (closes.length < slowPeriod + signalPeriod) {
    return { macdLine: null, signal: null, histogram: null };
  }

  const emaFast = calculateEMA(closes, fastPeriod);
  const emaSlow = calculateEMA(closes, slowPeriod);

  const offset = slowPeriod - fastPeriod;
  const macdSeries: number[] = [];

  for (let i = 0; i < emaSlow.length; i++) {
    macdSeries.push(emaFast[i + offset] - emaSlow[i]);
  }

  const signalSeries = calculateEMA(macdSeries, signalPeriod);

  if (signalSeries.length === 0) {
    return { macdLine: macdSeries[macdSeries.length - 1] ?? null, signal: null, histogram: null };
  }

  const macdLine = macdSeries[macdSeries.length - 1];
  const signal = signalSeries[signalSeries.length - 1];
  const histogram = macdLine - signal;

  return { macdLine, signal, histogram };
}

export function calculateBollingerBands(
  closes: number[],
  period: number = 20,
  stdDevMult: number = 2,
): { upper: number | null; middle: number | null; lower: number | null } {
  if (closes.length < period) {
    return { upper: null, middle: null, lower: null };
  }

  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, val) => sum + (val - mean) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);

  return {
    upper: mean + stdDevMult * stdDev,
    middle: mean,
    lower: mean - stdDevMult * stdDev,
  };
}

export function calculateVWAP(candles: Candle[]): number | null {
  if (candles.length === 0) return null;

  let tpv = 0;
  let vol = 0;

  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;
    tpv += typical * c.volume;
    vol += c.volume;
  }

  if (vol === 0) {
    // Fall back to simple average when volume is unavailable
    const avg = candles.reduce((sum, c) => sum + (c.high + c.low + c.close) / 3, 0) / candles.length;
    return avg;
  }

  return tpv / vol;
}

export function calculateATR(candles: Candle[], period: number = 14): number | null {
  if (candles.length < period + 1) return null;

  const trs: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }

  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }

  return atr;
}

export function calculateVolumeRatio(candles: Candle[], lookback: number = 20): number | null {
  if (candles.length < lookback + 1) return null;

  const recentVol = candles[candles.length - 1].volume;
  const avgVol =
    candles.slice(-lookback - 1, -1).reduce((sum, c) => sum + c.volume, 0) / lookback;

  if (avgVol === 0) return null;
  return recentVol / avgVol;
}

export function detectTrend(candles: Candle[], lookback: number = 20): 'UP' | 'DOWN' | 'SIDEWAYS' | 'UNKNOWN' {
  if (candles.length < lookback) return 'UNKNOWN';

  const slice = candles.slice(-lookback);
  const first = slice[0].close;
  const last = slice[slice.length - 1].close;
  const change = (last - first) / first;

  if (change > 0.02) return 'UP';
  if (change < -0.02) return 'DOWN';
  return 'SIDEWAYS';
}

export function snapshotIndicators(candles: Candle[]): IndicatorSnapshot {
  const closes = candles.map((c) => c.close);
  const price = closes.length > 0 ? closes[closes.length - 1] : 0;

  const rsi = calculateRSI(closes);
  const emaFastArr = calculateEMA(closes, 9);
  const emaSlowArr = calculateEMA(closes, 21);
  const macd = calculateMACD(closes);
  const bb = calculateBollingerBands(closes);
  const vwap = calculateVWAP(candles);
  const atr = calculateATR(candles);
  const volumeRatio = calculateVolumeRatio(candles);
  const trend = detectTrend(candles);

  return {
    price,
    rsi,
    emaFast: emaFastArr.length > 0 ? emaFastArr[emaFastArr.length - 1] : null,
    emaSlow: emaSlowArr.length > 0 ? emaSlowArr[emaSlowArr.length - 1] : null,
    macdLine: macd.macdLine,
    macdSignal: macd.signal,
    macdHistogram: macd.histogram,
    vwap,
    bbUpper: bb.upper,
    bbMiddle: bb.middle,
    bbLower: bb.lower,
    atr,
    volumeRatio,
    trend,
  };
}
