import { PublicKey } from '@solana/web3.js';
import {
  Liquidity,
  LiquidityPoolKeysV4,
  LiquidityStateV4,
  LIQUIDITY_STATE_LAYOUT_V4,
  MARKET_STATE_LAYOUT_V3,
  Market,
  TOKEN_PROGRAM_ID,
} from '@raydium-io/raydium-sdk';
import { MinimalMarketLayoutV3 } from './market';

export function createPoolKeys(
  id: PublicKey,
  accountData: LiquidityStateV4,
  minimalMarketLayoutV3: MinimalMarketLayoutV3,
): LiquidityPoolKeysV4 {
  const RAYDIUM_PROGRAM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
  const OPENBOOK_PROGRAM_ID = new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX');

  return {
    id,
    baseMint: accountData.baseMint,
    quoteMint: accountData.quoteMint,
    lpMint: accountData.lpMint,
    baseDecimals: accountData.baseDecimal.toNumber(),
    quoteDecimals: accountData.quoteDecimal.toNumber(),
    lpDecimals: 5,
    version: 4,
    programId: RAYDIUM_PROGRAM_ID,
    authority: Liquidity.getAssociatedAuthority({ programId: RAYDIUM_PROGRAM_ID }).publicKey,
    openOrders: accountData.openOrders,
    targetOrders: accountData.targetOrders,
    baseVault: accountData.baseVault,
    quoteVault: accountData.quoteVault,
    withdrawQueue: accountData.withdrawQueue,
    lpVault: accountData.lpVault,
    marketVersion: 3,
    marketProgramId: OPENBOOK_PROGRAM_ID,
    marketId: accountData.marketId,
    marketAuthority: Market.getAssociatedAuthority({
      programId: OPENBOOK_PROGRAM_ID,
      marketId: accountData.marketId,
    }).publicKey,
    marketBaseVault: accountData.baseVault,
    marketQuoteVault: accountData.quoteVault,
    marketBids: minimalMarketLayoutV3.bids,
    marketAsks: minimalMarketLayoutV3.asks,
    marketEventQueue: minimalMarketLayoutV3.eventQueue,
    lookupTableAccount: PublicKey.default,
  } as LiquidityPoolKeysV4;
}
