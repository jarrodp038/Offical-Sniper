import { Connection } from '@solana/web3.js';
import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { Filter, FilterResult } from './filter.interface';
import { logger } from '../helpers/logger';

export class BurnFilter implements Filter {
  constructor(private readonly connection: Connection) {}

  async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    try {
      const supply = await this.connection.getTokenSupply(poolKeys.lpMint);
      const burned = await this.connection.getTokenLargestAccounts(poolKeys.lpMint);

      if (!supply || !burned) {
        return { ok: false, message: 'Unable to fetch LP token data' };
      }

      const totalSupply = BigInt(supply.value.amount);
      if (totalSupply === BigInt(0)) {
        return { ok: true, message: 'LP tokens fully burned (zero supply)' };
      }

      // Check if the largest LP holder has burned (sent to a null/burn address)
      const largestAccounts = burned.value;
      let burnedAmount = BigInt(0);

      for (const account of largestAccounts) {
        const accountInfo = await this.connection.getAccountInfo(account.address);
        if (!accountInfo) {
          // Account doesn't exist — tokens are effectively burned
          burnedAmount += BigInt(account.amount);
        }
      }

      const burnPercentage = Number((burnedAmount * BigInt(100)) / totalSupply);

      if (burnPercentage > 50) {
        return { ok: true, message: `${burnPercentage}% of LP tokens burned` };
      }

      return {
        ok: false,
        message: `Only ${burnPercentage}% of LP tokens burned`,
      };
    } catch (e: any) {
      logger.error({ error: e.message }, 'BurnFilter error');
      return { ok: false, message: `BurnFilter error: ${e.message}` };
    }
  }
}
