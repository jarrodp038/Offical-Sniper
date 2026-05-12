import { Connection, PublicKey } from '@solana/web3.js';
import {
  LIQUIDITY_STATE_LAYOUT_V4,
  LiquidityPoolKeysV4,
  LiquidityStateV4,
} from '@raydium-io/raydium-sdk';
import { logger } from './logger';
import { getMinimalMarketV3, MinimalMarketLayoutV3 } from './market';
import { createPoolKeys } from './pool-keys';

const RAYDIUM_PROGRAM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');

export interface PoolMatch {
  poolId: PublicKey;
  poolState: LiquidityStateV4;
  poolKeys: LiquidityPoolKeysV4;
  marketData: MinimalMarketLayoutV3;
}

/**
 * Locate the most liquid Raydium AMM pool for a given base/quote pair.
 * Returns null if no pool exists.
 */
export async function findPoolForToken(
  connection: Connection,
  baseMint: PublicKey,
  quoteMint: PublicKey,
): Promise<PoolMatch | null> {
  try {
    const baseMintAccounts = await connection.getProgramAccounts(RAYDIUM_PROGRAM_ID, {
      filters: [
        { dataSize: LIQUIDITY_STATE_LAYOUT_V4.span },
        {
          memcmp: {
            offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('baseMint'),
            bytes: baseMint.toBase58(),
          },
        },
        {
          memcmp: {
            offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('quoteMint'),
            bytes: quoteMint.toBase58(),
          },
        },
      ],
    });

    // Also check the reverse pairing
    const quoteMintAccounts = await connection.getProgramAccounts(RAYDIUM_PROGRAM_ID, {
      filters: [
        { dataSize: LIQUIDITY_STATE_LAYOUT_V4.span },
        {
          memcmp: {
            offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('baseMint'),
            bytes: quoteMint.toBase58(),
          },
        },
        {
          memcmp: {
            offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('quoteMint'),
            bytes: baseMint.toBase58(),
          },
        },
      ],
    });

    const allAccounts = [...baseMintAccounts, ...quoteMintAccounts];

    if (allAccounts.length === 0) {
      logger.warn({ baseMint: baseMint.toBase58() }, 'No Raydium pool found for token');
      return null;
    }

    // Pick the pool with the largest quote vault balance
    let bestPool: { account: typeof allAccounts[0]; balance: bigint } | null = null;

    for (const account of allAccounts) {
      try {
        const state = LIQUIDITY_STATE_LAYOUT_V4.decode(account.account.data);
        const vaultInfo = await connection.getAccountInfo(state.quoteVault);
        if (!vaultInfo) continue;
        const balance = vaultInfo.data.readBigUInt64LE(64);

        if (!bestPool || balance > bestPool.balance) {
          bestPool = { account, balance };
        }
      } catch {
        continue;
      }
    }

    if (!bestPool) return null;

    const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(bestPool.account.account.data);
    const poolId = bestPool.account.pubkey;

    const marketData = await getMinimalMarketV3(connection, poolState.marketId);
    const poolKeys = createPoolKeys(poolId, poolState, marketData);

    return { poolId, poolState, poolKeys, marketData };
  } catch (e: any) {
    logger.error({ error: e.message, mint: baseMint.toBase58() }, 'findPoolForToken failed');
    return null;
  }
}
