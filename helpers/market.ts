import { Connection, PublicKey } from '@solana/web3.js';
import { MARKET_STATE_LAYOUT_V3 } from '@raydium-io/raydium-sdk';
import { logger } from './logger';

export interface MinimalMarketLayoutV3 {
  eventQueue: PublicKey;
  bids: PublicKey;
  asks: PublicKey;
}

export async function getMinimalMarketV3(
  connection: Connection,
  marketId: PublicKey,
  commitment?: string,
): Promise<MinimalMarketLayoutV3> {
  const marketInfo = await connection.getAccountInfo(marketId, {
    commitment: commitment as any,
  });

  if (!marketInfo) {
    throw new Error(`Market not found: ${marketId.toBase58()}`);
  }

  const decoded = MARKET_STATE_LAYOUT_V3.decode(marketInfo.data);

  return {
    eventQueue: decoded.eventQueue,
    bids: decoded.bids,
    asks: decoded.asks,
  };
}

export interface MinimalTokenAccountData {
  mint: PublicKey;
  address: PublicKey;
  poolKeys?: any;
  market?: MinimalMarketLayoutV3;
}

export async function fetchMarketAccounts(
  connection: Connection,
  baseMint: PublicKey,
  quoteMint: PublicKey,
  commitment: string,
): Promise<MinimalMarketLayoutV3 | null> {
  const OPENBOOK_PROGRAM_ID = new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX');

  const accounts = await connection.getProgramAccounts(OPENBOOK_PROGRAM_ID, {
    commitment: commitment as any,
    filters: [
      { dataSize: MARKET_STATE_LAYOUT_V3.span },
      {
        memcmp: {
          offset: MARKET_STATE_LAYOUT_V3.offsetOf('baseMint'),
          bytes: baseMint.toBase58(),
        },
      },
      {
        memcmp: {
          offset: MARKET_STATE_LAYOUT_V3.offsetOf('quoteMint'),
          bytes: quoteMint.toBase58(),
        },
      },
    ],
  });

  if (accounts.length === 0) {
    logger.debug({ baseMint: baseMint.toBase58() }, 'No market found');
    return null;
  }

  const decoded = MARKET_STATE_LAYOUT_V3.decode(accounts[0].account.data);

  return {
    eventQueue: decoded.eventQueue,
    bids: decoded.bids,
    asks: decoded.asks,
  };
}
