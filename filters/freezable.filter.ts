import { Connection } from '@solana/web3.js';
import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { getMint } from '@solana/spl-token';
import { Filter, FilterResult } from './filter.interface';
import { logger } from '../helpers/logger';

export class FreezableFilter implements Filter {
  constructor(private readonly connection: Connection) {}

  async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    try {
      const mintInfo = await getMint(this.connection, poolKeys.baseMint);

      if (mintInfo.freezeAuthority === null) {
        return { ok: true, message: 'No freeze authority — token is not freezable' };
      }

      return {
        ok: false,
        message: `Freeze authority exists: ${mintInfo.freezeAuthority.toBase58()}`,
      };
    } catch (e: any) {
      logger.error({ error: e.message }, 'FreezableFilter error');
      return { ok: false, message: `FreezableFilter error: ${e.message}` };
    }
  }
}
