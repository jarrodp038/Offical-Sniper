import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';

export interface FilterResult {
  ok: boolean;
  message?: string;
}

export interface Filter {
  execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult>;
}
