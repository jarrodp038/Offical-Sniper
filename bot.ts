import {
  Connection,
  Keypair,
  PublicKey,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  SystemProgram,
} from '@solana/web3.js';
import {
  Liquidity,
  LiquidityPoolKeysV4,
  LiquidityStateV4,
  Token,
  TokenAmount,
  Percent,
  TOKEN_PROGRAM_ID,
  SPL_ACCOUNT_LAYOUT,
} from '@raydium-io/raydium-sdk';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import * as fs from 'fs';
import { logger } from './helpers/logger';
import { MarketCache } from './cache/market-cache';
import { getMinimalMarketV3, MinimalMarketLayoutV3 } from './helpers/market';
import { createPoolKeys } from './helpers/pool-keys';
import { Filter, FilterResult } from './filters/filter.interface';
import { TransactionExecutor } from './transactions/transaction-executor.interface';
import BN from 'bn.js';

interface BotConfig {
  wallet: Keypair;
  quoteToken: Token;
  quoteAmount: TokenAmount;
  quoteMint: PublicKey;
  quoteAta: PublicKey;
  maxBuyRetries: number;
  maxSellRetries: number;
  buySlippage: number;
  sellSlippage: number;
  autoBuyDelay: number;
  autoSell: boolean;
  autoSellDelay: number;
  priceCheckInterval: number;
  priceCheckDuration: number;
  takeProfit: number;
  stopLoss: number;
  oneTokenAtATime: boolean;
  useSnipeList: boolean;
  snipeListRefreshInterval: number;
  filterCheckInterval: number;
  filterCheckDuration: number;
  consecutiveFilterMatches: number;
  computeUnitLimit: number;
  computeUnitPrice: number;
}

interface Position {
  poolKeys: LiquidityPoolKeysV4;
  mint: PublicKey;
  timestamp: number;
  tokenProgramId: PublicKey;
}

export class Bot {
  private readonly positions: Map<string, Position> = new Map();
  private snipeList: Set<string> = new Set();
  private snipeListInterval: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly connection: Connection,
    private readonly marketCache: MarketCache,
    private readonly txExecutor: TransactionExecutor,
    private readonly config: BotConfig,
    private readonly filters: Filter[],
  ) {
    if (this.config.useSnipeList) {
      this.loadSnipeList();
      this.snipeListInterval = setInterval(
        () => this.loadSnipeList(),
        this.config.snipeListRefreshInterval,
      );
    }
  }

  private loadSnipeList(): void {
    try {
      const content = fs.readFileSync('snipe-list.txt', 'utf-8');
      const mints = content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      this.snipeList = new Set(mints);
      logger.debug({ count: this.snipeList.size }, 'Snipe list loaded');
    } catch (e: any) {
      logger.error({ error: e.message }, 'Failed to load snipe list');
    }
  }

  async processPool(poolState: LiquidityStateV4, poolId: PublicKey): Promise<void> {
    const baseMint = poolState.baseMint.toBase58();

    // Skip if already holding this token
    if (this.positions.has(baseMint)) {
      logger.debug({ mint: baseMint }, 'Already holding position, skipping');
      return;
    }

    // One token at a time check
    if (this.config.oneTokenAtATime && this.positions.size > 0) {
      logger.debug('One token at a time enabled and already holding a position');
      return;
    }

    // Snipe list mode
    if (this.config.useSnipeList) {
      if (!this.snipeList.has(baseMint)) {
        logger.debug({ mint: baseMint }, 'Token not in snipe list, skipping');
        return;
      }
      logger.info({ mint: baseMint }, 'Token found in snipe list!');
    }

    // Get market data
    let marketData: MinimalMarketLayoutV3 | undefined;
    const marketId = poolState.marketId.toBase58();

    marketData = this.marketCache.get(marketId);

    if (!marketData) {
      try {
        marketData = await getMinimalMarketV3(this.connection, poolState.marketId);
        this.marketCache.set(marketId, marketData);
      } catch (e: any) {
        logger.error({ error: e.message, mint: baseMint }, 'Failed to fetch market data');
        return;
      }
    }

    const poolKeys = createPoolKeys(poolId, poolState, marketData);

    // Filter mode (when snipe list is disabled)
    if (!this.config.useSnipeList && this.filters.length > 0) {
      const passed = await this.runFilters(poolKeys);
      if (!passed) {
        logger.info({ mint: baseMint }, 'Token failed filters, skipping');
        return;
      }
    }

    // Auto buy delay
    if (this.config.autoBuyDelay > 0) {
      logger.debug({ delay: this.config.autoBuyDelay }, 'Waiting before buy...');
      await this.sleep(this.config.autoBuyDelay);
    }

    await this.buy(poolKeys, poolState);
  }

  private async runFilters(poolKeys: LiquidityPoolKeysV4): Promise<boolean> {
    let consecutivePasses = 0;
    const startTime = Date.now();
    const endTime = startTime + this.config.filterCheckDuration;

    while (Date.now() < endTime) {
      const results = await Promise.all(
        this.filters.map((filter) => filter.execute(poolKeys)),
      );

      const allPassed = results.every((r) => r.ok);

      if (allPassed) {
        consecutivePasses++;
        logger.debug(
          { consecutivePasses, required: this.config.consecutiveFilterMatches },
          'Filter check passed',
        );

        if (consecutivePasses >= this.config.consecutiveFilterMatches) {
          logger.info('All filters passed consecutively');
          return true;
        }
      } else {
        consecutivePasses = 0;
        const failures = results.filter((r) => !r.ok);
        logger.debug(
          { failures: failures.map((f) => f.message) },
          'Filter check failed',
        );
      }

      await this.sleep(this.config.filterCheckInterval);
    }

    return false;
  }

  private async detectTokenProgram(mint: PublicKey): Promise<PublicKey> {
    try {
      const info = await this.connection.getAccountInfo(mint);
      if (info && info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
        return TOKEN_2022_PROGRAM_ID;
      }
    } catch {}
    return TOKEN_PROGRAM_ID;
  }

  private async buy(poolKeys: LiquidityPoolKeysV4, poolState: LiquidityStateV4): Promise<void> {
    const baseMint = poolKeys.baseMint.toBase58();
    logger.info({ mint: baseMint }, 'Attempting to buy...');

    const tokenProgramId = await this.detectTokenProgram(poolKeys.baseMint);

    for (let attempt = 1; attempt <= this.config.maxBuyRetries; attempt++) {
      try {
        const tokenAta = await getAssociatedTokenAddress(
          poolKeys.baseMint,
          this.config.wallet.publicKey,
          false,
          tokenProgramId,
        );

        const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
          {
            poolKeys,
            userKeys: {
              tokenAccountIn: this.config.quoteAta,
              tokenAccountOut: tokenAta,
              owner: this.config.wallet.publicKey,
            },
            amountIn: this.config.quoteAmount.raw,
            minAmountOut: new BN(0),
          },
          poolKeys.version,
        );

        // SDK hardcodes TOKEN_PROGRAM_ID at account [0] — patch it for Token-2022
        if (tokenProgramId.equals(TOKEN_2022_PROGRAM_ID)) {
          for (const ix of innerTransaction.instructions) {
            if (ix.programId.equals(poolKeys.programId) && ix.keys.length > 0) {
              ix.keys[0] = { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false };
            }
          }
        }

        const latestBlockhash = await this.connection.getLatestBlockhash({
          commitment: this.connection.commitment,
        });

        const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
          this.config.wallet.publicKey,
          tokenAta,
          this.config.wallet.publicKey,
          poolKeys.baseMint,
          tokenProgramId,
        );

        // Wrap native SOL -> WSOL before swap when using WSOL as quote
        const wrapIxs = this.config.quoteMint.equals(NATIVE_MINT)
          ? [
              createAssociatedTokenAccountIdempotentInstruction(
                this.config.wallet.publicKey,
                this.config.quoteAta,
                this.config.wallet.publicKey,
                NATIVE_MINT,
              ),
              SystemProgram.transfer({
                fromPubkey: this.config.wallet.publicKey,
                toPubkey: this.config.quoteAta,
                lamports: this.config.quoteAmount.raw.toNumber(),
              }),
              createSyncNativeInstruction(this.config.quoteAta),
            ]
          : [];

        const messageV0 = new TransactionMessage({
          payerKey: this.config.wallet.publicKey,
          recentBlockhash: latestBlockhash.blockhash,
          instructions: [
            ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.computeUnitLimit }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.computeUnitPrice }),
            ...wrapIxs,
            createAtaIx,
            ...innerTransaction.instructions,
          ],
        }).compileToV0Message();

        const transaction = new VersionedTransaction(messageV0);
        transaction.sign([this.config.wallet, ...innerTransaction.signers]);

        const result = await this.txExecutor.executeAndConfirm(transaction, latestBlockhash);

        if (result.confirmed) {
          logger.info(
            {
              mint: baseMint,
              signature: result.signature,
              dexscreener: `https://dexscreener.com/solana/${baseMint}`,
            },
            'Buy successful!',
          );

          this.positions.set(baseMint, {
            poolKeys,
            mint: poolKeys.baseMint,
            timestamp: Date.now(),
            tokenProgramId,
          });

          if (this.config.autoSell) {
            this.startSellMonitor(poolKeys, tokenAta);
          }

          return;
        }

        logger.warn(
          { attempt, maxRetries: this.config.maxBuyRetries, error: result.error },
          'Buy attempt failed',
        );
      } catch (e: any) {
        logger.error({ error: e.message, attempt }, 'Buy error');
      }
    }

    logger.error({ mint: baseMint }, 'All buy attempts failed');
  }

  private startSellMonitor(poolKeys: LiquidityPoolKeysV4, tokenAta: PublicKey): void {
    const baseMint = poolKeys.baseMint.toBase58();

    logger.debug({ mint: baseMint }, 'Starting sell monitor...');

    // Monitor the token account for balance changes
    const subscriptionId = this.connection.onAccountChange(
      tokenAta,
      async (accountInfo) => {
        try {
          const parsed = SPL_ACCOUNT_LAYOUT.decode(accountInfo.data);
          const balance = parsed.amount;

          if (balance.isZero()) {
            logger.debug({ mint: baseMint }, 'Token balance is zero, skipping sell');
            return;
          }

          // Remove subscription once we detect balance
          this.connection.removeAccountChangeListener(subscriptionId);

          // Auto sell delay
          if (this.config.autoSellDelay > 0) {
            logger.debug({ delay: this.config.autoSellDelay }, 'Waiting before sell monitor...');
            await this.sleep(this.config.autoSellDelay);
          }

          await this.monitorPriceAndSell(poolKeys, tokenAta, balance);
        } catch (e: any) {
          logger.error({ error: e.message }, 'Sell monitor error');
        }
      },
      this.connection.commitment,
    );
  }

  private async monitorPriceAndSell(
    poolKeys: LiquidityPoolKeysV4,
    tokenAta: PublicKey,
    tokenBalance: BN,
  ): Promise<void> {
    const baseMint = poolKeys.baseMint.toBase58();
    const startTime = Date.now();
    const endTime = startTime + this.config.priceCheckDuration;

    logger.info(
      {
        mint: baseMint,
        takeProfit: `${this.config.takeProfit}%`,
        stopLoss: `${this.config.stopLoss}%`,
        duration: `${this.config.priceCheckDuration}ms`,
      },
      'Monitoring price for sell...',
    );

    const baseToken = new Token(TOKEN_PROGRAM_ID, poolKeys.baseMint, poolKeys.baseDecimals);

    while (Date.now() < endTime) {
      try {
        // Re-read current token balance
        const accountInfo = await this.connection.getAccountInfo(tokenAta);
        if (!accountInfo) {
          logger.warn({ mint: baseMint }, 'Token account not found');
          break;
        }

        const parsed = SPL_ACCOUNT_LAYOUT.decode(accountInfo.data);
        const currentBalance = parsed.amount;

        if (currentBalance.isZero()) {
          logger.info({ mint: baseMint }, 'Token balance is zero, position already closed');
          this.positions.delete(baseMint);
          return;
        }

        // Simulate sell to get expected output
        const poolInfo = await Liquidity.fetchInfo({
          connection: this.connection,
          poolKeys,
        });

        const amountOut = Liquidity.computeAmountOut({
          poolKeys,
          poolInfo,
          amountIn: new TokenAmount(baseToken, currentBalance),
          currencyOut: this.config.quoteToken,
          slippage: new Percent(0, 100),
        });

        const currentValue = amountOut.amountOut;
        const investedAmount = this.config.quoteAmount;

        // Calculate PnL percentage
        const pnlRaw = currentValue.raw.sub(investedAmount.raw);
        const pnlPercent = pnlRaw.mul(new BN(100)).div(investedAmount.raw).toNumber();

        logger.debug(
          {
            mint: baseMint,
            currentValue: currentValue.toFixed(),
            invested: investedAmount.toFixed(),
            pnl: `${pnlPercent}%`,
          },
          'Price check',
        );

        // Take profit
        if (pnlPercent >= this.config.takeProfit) {
          logger.info({ mint: baseMint, pnl: `${pnlPercent}%` }, 'Take profit triggered!');
          await this.sell(poolKeys, tokenAta, currentBalance);
          return;
        }

        // Stop loss
        if (pnlPercent <= -this.config.stopLoss) {
          logger.info({ mint: baseMint, pnl: `${pnlPercent}%` }, 'Stop loss triggered!');
          await this.sell(poolKeys, tokenAta, currentBalance);
          return;
        }
      } catch (e: any) {
        logger.debug({ error: e.message }, 'Price check error');
      }

      await this.sleep(this.config.priceCheckInterval);
    }

    // Duration elapsed — sell regardless
    logger.info({ mint: baseMint }, 'Price check duration elapsed, selling...');
    try {
      const accountInfo = await this.connection.getAccountInfo(tokenAta);
      if (accountInfo) {
        const parsed = SPL_ACCOUNT_LAYOUT.decode(accountInfo.data);
        if (!parsed.amount.isZero()) {
          await this.sell(poolKeys, tokenAta, parsed.amount);
        }
      }
    } catch (e: any) {
      logger.error({ error: e.message }, 'Final sell error');
    }
  }

  private async sell(
    poolKeys: LiquidityPoolKeysV4,
    tokenAta: PublicKey,
    amount: BN,
    tokenProgramId?: PublicKey,
  ): Promise<void> {
    const baseMint = poolKeys.baseMint.toBase58();
    logger.info({ mint: baseMint, amount: amount.toString() }, 'Attempting to sell...');

    const resolvedTokenProgram = tokenProgramId || await this.detectTokenProgram(poolKeys.baseMint);
    const baseToken = new Token(TOKEN_PROGRAM_ID, poolKeys.baseMint, poolKeys.baseDecimals);

    for (let attempt = 1; attempt <= this.config.maxSellRetries; attempt++) {
      try {
        const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
          {
            poolKeys,
            userKeys: {
              tokenAccountIn: tokenAta,
              tokenAccountOut: this.config.quoteAta,
              owner: this.config.wallet.publicKey,
            },
            amountIn: amount,
            minAmountOut: new BN(0),
          },
          poolKeys.version,
        );

        // SDK hardcodes TOKEN_PROGRAM_ID at account [0] — patch it for Token-2022
        if (resolvedTokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
          for (const ix of innerTransaction.instructions) {
            if (ix.programId.equals(poolKeys.programId) && ix.keys.length > 0) {
              ix.keys[0] = { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false };
            }
          }
        }

        const latestBlockhash = await this.connection.getLatestBlockhash({
          commitment: this.connection.commitment,
        });

        // Unwrap WSOL -> native SOL after sell when using WSOL as quote
        const unwrapIxs = this.config.quoteMint.equals(NATIVE_MINT)
          ? [
              createCloseAccountInstruction(
                this.config.quoteAta,
                this.config.wallet.publicKey,
                this.config.wallet.publicKey,
              ),
            ]
          : [];

        const messageV0 = new TransactionMessage({
          payerKey: this.config.wallet.publicKey,
          recentBlockhash: latestBlockhash.blockhash,
          instructions: [
            ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.computeUnitLimit }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.computeUnitPrice }),
            ...innerTransaction.instructions,
            ...unwrapIxs,
          ],
        }).compileToV0Message();

        const transaction = new VersionedTransaction(messageV0);
        transaction.sign([this.config.wallet, ...innerTransaction.signers]);

        const result = await this.txExecutor.executeAndConfirm(transaction, latestBlockhash);

        if (result.confirmed) {
          logger.info(
            {
              mint: baseMint,
              signature: result.signature,
            },
            'Sell successful!',
          );

          this.positions.delete(baseMint);
          return;
        }

        logger.warn(
          { attempt, maxRetries: this.config.maxSellRetries, error: result.error },
          'Sell attempt failed',
        );
      } catch (e: any) {
        logger.error({ error: e.message, attempt }, 'Sell error');
      }
    }

    logger.error({ mint: baseMint }, 'All sell attempts failed');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
