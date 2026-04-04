import { Connection } from '@solana/web3.js';
import { LiquidityPoolKeysV4, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { Filter, FilterResult } from './filter.interface';
import { logger } from '../helpers/logger';

export class PoolSizeFilter implements Filter {
  constructor(
    private readonly connection: Connection,
    private readonly quoteToken: Token,
    private readonly minPoolSize: TokenAmount,
    private readonly maxPoolSize: TokenAmount,
  ) {}

  async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    try {
      const accountInfo = await this.connection.getAccountInfo(poolKeys.quoteVault);

      if (!accountInfo) {
        return { ok: false, message: 'Quote vault account not found' };
      }

      // SPL Token account data: amount is at offset 64, 8 bytes LE
      const balance = accountInfo.data.readBigUInt64LE(64);
      const poolSize = new TokenAmount(this.quoteToken, balance.toString(), true);

      const minOk = this.minPoolSize.isZero() || poolSize.raw.gte(this.minPoolSize.raw);
      const maxOk = this.maxPoolSize.isZero() || poolSize.raw.lte(this.maxPoolSize.raw);

      if (!minOk) {
        return {
          ok: false,
          message: `Pool size ${poolSize.toFixed()} < min ${this.minPoolSize.toFixed()}`,
        };
      }

      if (!maxOk) {
        return {
          ok: false,
          message: `Pool size ${poolSize.toFixed()} > max ${this.maxPoolSize.toFixed()}`,
        };
      }

      return { ok: true, message: `Pool size: ${poolSize.toFixed()}` };
    } catch (e: any) {
      logger.error({ error: e.message }, 'PoolSizeFilter error');
      return { ok: false, message: `PoolSizeFilter error: ${e.message}` };
    }
  }
}
