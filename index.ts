import dotenv from 'dotenv';
import {
  Connection,
  Keypair,
  PublicKey,
  Commitment,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  Token,
  TokenAmount,
  TOKEN_PROGRAM_ID,
} from '@raydium-io/raydium-sdk';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import bs58 from 'bs58';
import BN from 'bn.js';

import { Bot } from './bot';
import { Listener } from './listeners/listeners';
import { MarketCache } from './cache/market-cache';
import { DefaultTransactionExecutor } from './transactions/default-executor';
import { WarpTransactionExecutor } from './transactions/warp-executor';
import { JitoTransactionExecutor } from './transactions/jito-executor';
import { TransactionExecutor } from './transactions/transaction-executor.interface';
import { Filter } from './filters/filter.interface';
import { PoolSizeFilter } from './filters/pool-size.filter';
import { BurnFilter } from './filters/burn.filter';
import { RenouncedFilter } from './filters/renounced.filter';
import { MutableFilter } from './filters/mutable.filter';
import { SocialsFilter } from './filters/socials.filter';
import { FreezableFilter } from './filters/freezable.filter';
import { PatternTrader } from './trader/pattern-trader';
import { PriceFeed } from './analysis/price-feed';
import { DEFAULT_SIGNAL_CONFIG } from './analysis/signal-engine';
import { logger } from './helpers/logger';

dotenv.config();

function getEnvString(key: string, fallback?: string): string {
  const value = process.env[key];
  if (value !== undefined && value !== '') return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable: ${key}`);
}

function getEnvNumber(key: string, fallback?: number): number {
  const raw = process.env[key];
  if (raw !== undefined && raw !== '') {
    const num = Number(raw);
    if (isNaN(num)) throw new Error(`Invalid number for ${key}: ${raw}`);
    return num;
  }
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable: ${key}`);
}

function getEnvBool(key: string, fallback?: boolean): boolean {
  const raw = process.env[key];
  if (raw !== undefined && raw !== '') return raw.toLowerCase() === 'true';
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable: ${key}`);
}

const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

function resolveQuoteMint(name: string): { mint: PublicKey; decimals: number } {
  switch (name.toUpperCase()) {
    case 'WSOL':
      return { mint: WSOL_MINT, decimals: 9 };
    case 'USDC':
      return { mint: USDC_MINT, decimals: 6 };
    default:
      throw new Error(`Unsupported QUOTE_MINT: ${name}. Use WSOL or USDC.`);
  }
}

async function main(): Promise<void> {
  logger.info('=== Solana Trading Bot Starting ===');

  // Trading mode
  const tradingMode = getEnvString('TRADING_MODE', 'sniper').toLowerCase();
  logger.info({ tradingMode }, 'Trading mode selected');

  // Common config
  const privateKey = getEnvString('PRIVATE_KEY');
  const rpcEndpoint = getEnvString('RPC_ENDPOINT');
  const rpcWsEndpoint = getEnvString('RPC_WEBSOCKET_ENDPOINT');
  const commitmentLevel = getEnvString('COMMITMENT_LEVEL', 'confirmed') as Commitment;

  const computeUnitLimit = getEnvNumber('COMPUTE_UNIT_LIMIT', 100000);
  const computeUnitPrice = getEnvNumber('COMPUTE_UNIT_PRICE', 421197);
  const txExecutorType = getEnvString('TRANSACTION_EXECUTOR', 'default');
  const customFee = getEnvNumber('CUSTOM_FEE', 0.006);

  const quoteMintName = getEnvString('QUOTE_MINT', 'WSOL');
  const quoteAmountRaw = getEnvNumber('QUOTE_AMOUNT', 0.01);
  const maxBuyRetries = getEnvNumber('MAX_BUY_RETRIES', 3);
  const buySlippage = getEnvNumber('BUY_SLIPPAGE', 10);
  const maxSellRetries = getEnvNumber('MAX_SELL_RETRIES', 3);
  const sellSlippage = getEnvNumber('SELL_SLIPPAGE', 10);

  // Decode wallet
  let wallet: Keypair;
  try {
    wallet = Keypair.fromSecretKey(bs58.decode(privateKey));
  } catch {
    throw new Error('Invalid PRIVATE_KEY. Must be a base58-encoded secret key.');
  }
  logger.info({ wallet: wallet.publicKey.toBase58() }, 'Wallet loaded');

  const connection = new Connection(rpcEndpoint, {
    wsEndpoint: rpcWsEndpoint,
    commitment: commitmentLevel,
  });

  const { mint: quoteMint, decimals: quoteDecimals } = resolveQuoteMint(quoteMintName);
  const quoteToken = new Token(TOKEN_PROGRAM_ID, quoteMint, quoteDecimals, quoteMintName);

  const quoteAmountBN = new BN(Math.round(quoteAmountRaw * 10 ** quoteDecimals));
  const quoteAmount = new TokenAmount(quoteToken, quoteAmountBN);

  const quoteAta = await getAssociatedTokenAddress(quoteMint, wallet.publicKey);
  logger.info({ quoteAta: quoteAta.toBase58() }, 'Quote token ATA');

  const solBalance = await connection.getBalance(wallet.publicKey);
  logger.info({ solBalance: solBalance / LAMPORTS_PER_SOL }, 'SOL balance');

  if (solBalance < 0.01 * LAMPORTS_PER_SOL) {
    logger.error('Insufficient SOL balance. Need at least 0.01 SOL for fees.');
    process.exit(1);
  }

  try {
    const quoteTokenBalance = await connection.getTokenAccountBalance(quoteAta);
    logger.info(
      { balance: quoteTokenBalance.value.uiAmountString, token: quoteMintName },
      'Quote token balance',
    );
  } catch {
    logger.warn('Quote token ATA not found. Ensure you have wrapped SOL or USDC.');
  }

  // Build transaction executor
  let txExecutor: TransactionExecutor;
  switch (txExecutorType.toLowerCase()) {
    case 'warp':
      txExecutor = new WarpTransactionExecutor(connection, wallet, customFee);
      logger.info({ fee: customFee }, 'Using Warp transaction executor');
      break;
    case 'jito':
      txExecutor = new JitoTransactionExecutor(connection, wallet, customFee);
      logger.info({ fee: customFee }, 'Using Jito transaction executor');
      break;
    default:
      txExecutor = new DefaultTransactionExecutor(connection, wallet, computeUnitLimit, computeUnitPrice);
      logger.info('Using default transaction executor');
      break;
  }

  if (tradingMode === 'pattern') {
    await runPatternMode({
      connection,
      wallet,
      txExecutor,
      quoteToken,
      quoteMint,
      quoteAta,
      quoteAmount,
      computeUnitLimit,
      computeUnitPrice,
      maxBuyRetries,
      maxSellRetries,
      buySlippage,
      sellSlippage,
    });
  } else {
    await runSniperMode({
      connection,
      wallet,
      txExecutor,
      quoteToken,
      quoteMint,
      quoteAta,
      quoteAmount,
      quoteDecimals,
      computeUnitLimit,
      computeUnitPrice,
      maxBuyRetries,
      maxSellRetries,
      buySlippage,
      sellSlippage,
      commitmentLevel,
    });
  }

  logger.info('=== Bot is running. Press Ctrl+C to stop. ===');

  process.on('SIGINT', () => {
    logger.info('Shutting down...');
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    logger.info('Shutting down...');
    process.exit(0);
  });

  await new Promise(() => {});
}

interface CommonArgs {
  connection: Connection;
  wallet: Keypair;
  txExecutor: TransactionExecutor;
  quoteToken: Token;
  quoteMint: PublicKey;
  quoteAta: PublicKey;
  quoteAmount: TokenAmount;
  computeUnitLimit: number;
  computeUnitPrice: number;
  maxBuyRetries: number;
  maxSellRetries: number;
  buySlippage: number;
  sellSlippage: number;
}

async function runPatternMode(args: CommonArgs): Promise<void> {
  const tradingTokensRaw = getEnvString('TRADING_TOKENS');
  const tradingTokens = tradingTokensRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => new PublicKey(s));

  if (tradingTokens.length === 0) {
    throw new Error('TRADING_TOKENS is empty. Provide a comma-separated list of mint addresses.');
  }

  const analysisIntervalMs = getEnvNumber('ANALYSIS_INTERVAL_MS', 10000);
  const maxConcurrentPositions = getEnvNumber('MAX_CONCURRENT_POSITIONS', 3);

  const rsiOversold = getEnvNumber('RSI_OVERSOLD', 30);
  const rsiOverbought = getEnvNumber('RSI_OVERBOUGHT', 70);
  const minConfidenceToBuy = getEnvNumber('MIN_CONFIDENCE_TO_BUY', 60);
  const minConfidenceToSell = getEnvNumber('MIN_CONFIDENCE_TO_SELL', 55);
  const minCandles = getEnvNumber('MIN_CANDLES', 30);

  const takeProfitPercent = getEnvNumber('PATTERN_TAKE_PROFIT', 50);
  const stopLossPercent = getEnvNumber('PATTERN_STOP_LOSS', 25);
  const trailingStopPercent = getEnvNumber('TRAILING_STOP_PERCENT', 15);
  const activateTrailingAt = getEnvNumber('ACTIVATE_TRAILING_AT', 20);

  const priceFeed = new PriceFeed(args.connection);

  const trader = new PatternTrader(args.connection, args.txExecutor, priceFeed, {
    wallet: args.wallet,
    quoteToken: args.quoteToken,
    quoteMint: args.quoteMint,
    quoteAta: args.quoteAta,
    quoteAmountPerPosition: args.quoteAmount.raw,
    tradingTokens,
    analysisIntervalMs,
    maxConcurrentPositions,
    computeUnitLimit: args.computeUnitLimit,
    computeUnitPrice: args.computeUnitPrice,
    maxBuyRetries: args.maxBuyRetries,
    maxSellRetries: args.maxSellRetries,
    buySlippage: args.buySlippage,
    sellSlippage: args.sellSlippage,
    signalConfig: {
      ...DEFAULT_SIGNAL_CONFIG,
      rsiOversold,
      rsiOverbought,
      minConfidenceToBuy,
      minConfidenceToSell,
      minCandles,
    },
    riskConfig: {
      takeProfitPercent,
      stopLossPercent,
      trailingStopPercent,
      activateTrailingAt,
    },
  });

  await trader.start();

  process.on('SIGINT', async () => {
    await trader.stop();
    process.exit(0);
  });
}

async function runSniperMode(
  args: CommonArgs & { quoteDecimals: number; commitmentLevel: Commitment },
): Promise<void> {
  const oneTokenAtATime = getEnvBool('ONE_TOKEN_AT_A_TIME', true);
  const autoBuyDelay = getEnvNumber('AUTO_BUY_DELAY', 0);
  const autoSell = getEnvBool('AUTO_SELL', true);
  const autoSellDelay = getEnvNumber('AUTO_SELL_DELAY', 0);
  const priceCheckInterval = getEnvNumber('PRICE_CHECK_INTERVAL', 2000);
  const priceCheckDuration = getEnvNumber('PRICE_CHECK_DURATION', 60000);
  const takeProfit = getEnvNumber('TAKE_PROFIT', 50);
  const stopLoss = getEnvNumber('STOP_LOSS', 30);
  const useSnipeList = getEnvBool('USE_SNIPE_LIST', false);
  const snipeListRefreshInterval = getEnvNumber('SNIPE_LIST_REFRESH_INTERVAL', 5000);
  const filterCheckInterval = getEnvNumber('FILTER_CHECK_INTERVAL', 1000);
  const filterCheckDuration = getEnvNumber('FILTER_CHECK_DURATION', 10000);
  const consecutiveFilterMatches = getEnvNumber('CONSECUTIVE_FILTER_MATCHES', 3);
  const checkIfMutable = getEnvBool('CHECK_IF_MUTABLE', true);
  const checkIfSocials = getEnvBool('CHECK_IF_SOCIALS', true);
  const checkIfMintIsRenounced = getEnvBool('CHECK_IF_MINT_IS_RENOUNCED', true);
  const checkIfFreezable = getEnvBool('CHECK_IF_FREEZABLE', true);
  const checkIfBurned = getEnvBool('CHECK_IF_BURNED', true);
  const minPoolSize = getEnvNumber('MIN_POOL_SIZE', 0);
  const maxPoolSize = getEnvNumber('MAX_POOL_SIZE', 0);
  const preLoadExistingMarkets = getEnvBool('PRE_LOAD_EXISTING_MARKETS', false);
  const cacheNewMarkets = getEnvBool('CACHE_NEW_MARKETS', true);

  const marketCache = new MarketCache(args.connection);
  await marketCache.init(preLoadExistingMarkets, args.quoteMint);

  const filters: Filter[] = [];
  if (!useSnipeList) {
    if (checkIfBurned) filters.push(new BurnFilter(args.connection));
    if (checkIfMintIsRenounced) filters.push(new RenouncedFilter(args.connection));
    if (checkIfMutable) filters.push(new MutableFilter(args.connection));
    if (checkIfSocials) filters.push(new SocialsFilter(args.connection));
    if (checkIfFreezable) filters.push(new FreezableFilter(args.connection));
    if (minPoolSize > 0 || maxPoolSize > 0) {
      const minAmount = new TokenAmount(
        args.quoteToken,
        new BN(Math.round(minPoolSize * 10 ** args.quoteDecimals)),
      );
      const maxAmount = new TokenAmount(
        args.quoteToken,
        new BN(Math.round(maxPoolSize * 10 ** args.quoteDecimals)),
      );
      filters.push(new PoolSizeFilter(args.connection, args.quoteToken, minAmount, maxAmount));
    }
  }

  const bot = new Bot(args.connection, marketCache, args.txExecutor, {
    wallet: args.wallet,
    quoteToken: args.quoteToken,
    quoteAmount: args.quoteAmount,
    quoteMint: args.quoteMint,
    quoteAta: args.quoteAta,
    maxBuyRetries: args.maxBuyRetries,
    maxSellRetries: args.maxSellRetries,
    buySlippage: args.buySlippage,
    sellSlippage: args.sellSlippage,
    autoBuyDelay,
    autoSell,
    autoSellDelay,
    priceCheckInterval,
    priceCheckDuration,
    takeProfit,
    stopLoss,
    oneTokenAtATime,
    useSnipeList,
    snipeListRefreshInterval,
    filterCheckInterval,
    filterCheckDuration,
    consecutiveFilterMatches,
    computeUnitLimit: args.computeUnitLimit,
    computeUnitPrice: args.computeUnitPrice,
  }, filters);

  const listener = new Listener(
    args.connection,
    marketCache,
    args.quoteMint,
    args.commitmentLevel,
    cacheNewMarkets,
  );

  await listener.start((poolState, poolId) => {
    bot.processPool(poolState, poolId).catch((e) => {
      logger.error({ error: e.message }, 'Error processing pool');
    });
  });
}

main().catch((error) => {
  logger.error({ error: error.message }, 'Fatal error');
  process.exit(1);
});
