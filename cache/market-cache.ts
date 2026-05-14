import { Connection, PublicKey } from '@solana/web3.js';
import { MARKET_STATE_LAYOUT_V3 } from '@raydium-io/raydium-sdk';
import { MinimalMarketLayoutV3 } from '../helpers/market';
import { logger } from '../helpers/logger';

export class MarketCache {
  private readonly cache: Map<string, MinimalMarketLayoutV3> = new Map();
  private readonly OPENBOOK_PROGRAM_ID = new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX');

  constructor(private readonly connection: Connection) {}

  async init(preLoad: boolean, quoteMint: PublicKey): Promise<void> {
    if (!preLoad) {
      logger.info('Market pre-loading disabled');
      return;
    }

    logger.info('Pre-loading existing markets...');

    const accounts = await this.connection.getProgramAccounts(this.OPENBOOK_PROGRAM_ID, {
      commitment: this.connection.commitment,
      filters: [
        { dataSize: MARKET_STATE_LAYOUT_V3.span },
        {
          memcmp: {
            offset: MARKET_STATE_LAYOUT_V3.offsetOf('quoteMint'),
            bytes: quoteMint.toBase58(),
          },
        },
      ],
    });

    for (const account of accounts) {
      const decoded = MARKET_STATE_LAYOUT_V3.decode(account.account.data);
      this.cache.set(account.pubkey.toBase58(), {
        bids: decoded.bids,
        asks: decoded.asks,
        eventQueue: decoded.eventQueue,
        baseVault: decoded.baseVault,
        quoteVault: decoded.quoteVault,
      });
    }

    logger.info(`Loaded ${this.cache.size} markets`);
  }

  get(marketId: string): MinimalMarketLayoutV3 | undefined {
    return this.cache.get(marketId);
  }

  set(marketId: string, market: MinimalMarketLayoutV3): void {
    this.cache.set(marketId, market);
  }

  get size(): number {
    return this.cache.size;
  }
}
