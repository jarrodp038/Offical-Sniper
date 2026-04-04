import { Connection, PublicKey, Commitment } from '@solana/web3.js';
import { LIQUIDITY_STATE_LAYOUT_V4, LiquidityStateV4, MARKET_STATE_LAYOUT_V3 } from '@raydium-io/raydium-sdk';
import { logger } from '../helpers/logger';
import { MarketCache } from '../cache/market-cache';

const RAYDIUM_PROGRAM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const OPENBOOK_PROGRAM_ID = new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX');

export class Listener {
  private subscriptionId: number | undefined;

  constructor(
    private readonly connection: Connection,
    private readonly marketCache: MarketCache,
    private readonly quoteMint: PublicKey,
    private readonly commitment: Commitment,
    private readonly cacheNewMarkets: boolean,
  ) {}

  async start(
    onPoolDetected: (poolState: LiquidityStateV4, poolId: PublicKey) => void,
  ): Promise<void> {
    logger.info('Starting Raydium pool listener...');

    this.subscriptionId = this.connection.onProgramAccountChange(
      RAYDIUM_PROGRAM_ID,
      async (updatedAccountInfo, context) => {
        const accountData = updatedAccountInfo.accountInfo;

        if (accountData.data.length !== LIQUIDITY_STATE_LAYOUT_V4.span) {
          return;
        }

        try {
          const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(accountData.data);

          // Only process pools with the configured quote mint
          if (!poolState.quoteMint.equals(this.quoteMint)) {
            return;
          }

          // Check if pool status indicates it's initialized (status 6 = initialized)
          if (poolState.status.toNumber() !== 6 && poolState.status.toNumber() !== 1) {
            return;
          }

          const poolId = updatedAccountInfo.accountId;

          logger.info(
            {
              poolId: poolId.toBase58(),
              baseMint: poolState.baseMint.toBase58(),
              quoteMint: poolState.quoteMint.toBase58(),
            },
            'New pool detected',
          );

          // Cache market data if enabled
          if (this.cacheNewMarkets) {
            const marketId = poolState.marketId.toBase58();
            if (!this.marketCache.get(marketId)) {
              try {
                const marketAccountInfo = await this.connection.getAccountInfo(poolState.marketId);
                if (marketAccountInfo) {
                  const decoded = MARKET_STATE_LAYOUT_V3.decode(marketAccountInfo.data);
                  this.marketCache.set(marketId, {
                    bids: decoded.bids,
                    asks: decoded.asks,
                    eventQueue: decoded.eventQueue,
                  });
                  logger.debug({ marketId }, 'Cached new market');
                }
              } catch (e: any) {
                logger.debug({ error: e.message }, 'Failed to cache market');
              }
            }
          }

          onPoolDetected(poolState, poolId);
        } catch (e: any) {
          logger.trace({ error: e.message }, 'Failed to decode pool state');
        }
      },
      this.commitment,
      [
        { dataSize: LIQUIDITY_STATE_LAYOUT_V4.span },
        {
          memcmp: {
            offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('quoteMint'),
            bytes: this.quoteMint.toBase58(),
          },
        },
      ],
    );

    logger.info('Pool listener started');
  }

  stop(): void {
    if (this.subscriptionId !== undefined) {
      this.connection.removeProgramAccountChangeListener(this.subscriptionId);
      this.subscriptionId = undefined;
      logger.info('Pool listener stopped');
    }
  }
}
