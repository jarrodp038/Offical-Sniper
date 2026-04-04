import { Connection } from '@solana/web3.js';
import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { getMint } from '@solana/spl-token';
import { Filter, FilterResult } from './filter.interface';
import { logger } from '../helpers/logger';

export class RenouncedFilter implements Filter {
  constructor(private readonly connection: Connection) {}

  async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    try {
      const mintInfo = await getMint(this.connection, poolKeys.baseMint);

      if (mintInfo.mintAuthority === null) {
        return { ok: true, message: 'Mint authority is renounced' };
      }

      return {
        ok: false,
        message: `Mint authority exists: ${mintInfo.mintAuthority.toBase58()}`,
      };
    } catch (e: any) {
      logger.error({ error: e.message }, 'RenouncedFilter error');
      return { ok: false, message: `RenouncedFilter error: ${e.message}` };
    }
  }
}
