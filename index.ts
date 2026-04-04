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
import { logger } from './helpers/logger';

dotenv.config();

// --- Environment Variable Helpers ---

function getEnvString(key: string, fallback?: string): string {
  const value = process.env[key];
  if (value !== undefined) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable: ${key}`);
}

function getEnvNumber(key: string, fallback?: number): number {
  const raw = process.env[key];
  if (raw !== undefined) {
    const num = Number(raw);
    if (isNaN(num)) throw new Error(`Invalid number for ${key}: ${raw}`);
    return num;
  }
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable: ${key}`);
}

function getEnvBool(key: string, fallback?: boolean): boolean {
  const raw = process.env[key];
  if (raw !== undefined) return raw.toLowerCase() === 'true';
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable: ${key}`);
}

// --- Quote Mint Resolution ---

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

// --- Main ---

async function main(): Promise<void> {
  logger.info('=== Solana Sniper Bot Starting ===');

  // Load config
  const privateKey = getEnvString('PRIVATE_KEY');
  const rpcEndpoint = getEnvString('RPC_ENDPOINT');
  const rpcWsEndpoint = getEnvString('RPC_WEBSOCKET_ENDPOINT');
  const commitmentLevel = getEnvString('COMMITMENT_LEVEL', 'confirmed') as Commitment;

  const oneTokenAtATime = getEnvBool('ONE_TOKEN_AT_A_TIME', true);
  const computeUnitLimit = getEnvNumber('COMPUTE_UNIT_LIMIT', 100000);
  const computeUnitPrice = getEnvNumber('COMPUTE_UNIT_PRICE', 421197);
  const preLoadExistingMarkets = getEnvBool('PRE_LOAD_EXISTING_MARKETS', false);
  const cacheNewMarkets = getEnvBool('CACHE_NEW_MARKETS', true);
  const txExecutorType = getEnvString('TRANSACTION_EXECUTOR', 'default');
  const customFee = getEnvNumber('CUSTOM_FEE', 0.006);

  const quoteMintName = getEnvString('QUOTE_MINT', 'WSOL');
  const quoteAmountRaw = getEnvNumber('QUOTE_AMOUNT', 0.01);
  const autoBuyDelay = getEnvNumber('AUTO_BUY_DELAY', 0);
  const maxBuyRetries = getEnvNumber('MAX_BUY_RETRIES', 3);
  const buySlippage = getEnvNumber('BUY_SLIPPAGE', 10);

  const autoSell = getEnvBool('AUTO_SELL', true);
  const maxSellRetries = getEnvNumber('MAX_SELL_RETRIES', 3);
  const autoSellDelay = getEnvNumber('AUTO_SELL_DELAY', 0);
  const priceCheckInterval = getEnvNumber('PRICE_CHECK_INTERVAL', 2000);
  const priceCheckDuration = getEnvNumber('PRICE_CHECK_DURATION', 60000);
  const takeProfit = getEnvNumber('TAKE_PROFIT', 50);
  const stopLoss = getEnvNumber('STOP_LOSS', 30);
  const sellSlippage = getEnvNumber('SELL_SLIPPAGE', 10);

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

  // Decode wallet
  let wallet: Keypair;
  try {
    wallet = Keypair.fromSecretKey(bs58.decode(privateKey));
  } catch {
    throw new Error('Invalid PRIVATE_KEY. Must be a base58-encoded secret key.');
  }

  logger.info({ wallet: wallet.publicKey.toBase58() }, 'Wallet loaded');

  // Create connection
  const connection = new Connection(rpcEndpoint, {
    wsEndpoint: rpcWsEndpoint,
    commitment: commitmentLevel,
  });

  // Resolve quote token
  const { mint: quoteMint, decimals: quoteDecimals } = resolveQuoteMint(quoteMintName);
  const quoteToken = new Token(TOKEN_PROGRAM_ID, quoteMint, quoteDecimals, quoteMintName);

  // Convert quote amount to token amount using BN (no floating point math for on-chain amounts)
  const quoteAmountBN = new BN(Math.round(quoteAmountRaw * 10 ** quoteDecimals));
  const quoteAmount = new TokenAmount(quoteToken, quoteAmountBN);

  // Find or create associated token account for quote mint
  const quoteAta = await getAssociatedTokenAddress(quoteMint, wallet.publicKey);
  logger.info({ quoteAta: quoteAta.toBase58() }, 'Quote token ATA');

  // Check balances
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

  // Initialize market cache
  const marketCache = new MarketCache(connection);
  await marketCache.init(preLoadExistingMarkets, quoteMint);

  // Initialize transaction executor
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

  // Initialize filters
  const filters: Filter[] = [];

  if (!useSnipeList) {
    if (checkIfBurned) {
      filters.push(new BurnFilter(connection));
      logger.info('BurnFilter enabled');
    }

    if (checkIfMintIsRenounced) {
      filters.push(new RenouncedFilter(connection));
      logger.info('RenouncedFilter enabled');
    }

    if (checkIfMutable) {
      filters.push(new MutableFilter(connection));
      logger.info('MutableFilter enabled');
    }

    if (checkIfSocials) {
      filters.push(new SocialsFilter(connection));
      logger.info('SocialsFilter enabled');
    }

    if (checkIfFreezable) {
      filters.push(new FreezableFilter(connection));
      logger.info('FreezableFilter enabled');
    }

    if (minPoolSize > 0 || maxPoolSize > 0) {
      const minAmount = new TokenAmount(
        quoteToken,
        new BN(Math.round(minPoolSize * 10 ** quoteDecimals)),
      );
      const maxAmount = new TokenAmount(
        quoteToken,
        new BN(Math.round(maxPoolSize * 10 ** quoteDecimals)),
      );
      filters.push(new PoolSizeFilter(connection, quoteToken, minAmount, maxAmount));
      logger.info({ minPoolSize, maxPoolSize }, 'PoolSizeFilter enabled');
    }
  }

  // Initialize bot
  const bot = new Bot(connection, marketCache, txExecutor, {
    wallet,
    quoteToken,
    quoteAmount,
    quoteMint,
    quoteAta,
    maxBuyRetries,
    maxSellRetries,
    buySlippage,
    sellSlippage,
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
    computeUnitLimit,
    computeUnitPrice,
  }, filters);

  // Initialize listener
  const listener = new Listener(
    connection,
    marketCache,
    quoteMint,
    commitmentLevel,
    cacheNewMarkets,
  );

  // Start listening
  await listener.start((poolState, poolId) => {
    bot.processPool(poolState, poolId).catch((e) => {
      logger.error({ error: e.message }, 'Error processing pool');
    });
  });

  logger.info('=== Bot is running. Press Ctrl+C to stop. ===');

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down...');
    listener.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep the process alive
  await new Promise(() => {});
}

main().catch((error) => {
  logger.error({ error: error.message }, 'Fatal error');
  process.exit(1);
});
