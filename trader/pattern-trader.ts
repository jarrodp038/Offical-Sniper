import {
  Connection,
  Keypair,
  PublicKey,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
  SystemProgram,
} from '@solana/web3.js';
import {
  Liquidity,
  LiquidityPoolKeysV4,
  Token,
  TokenAmount,
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
import BN from 'bn.js';
import { logger } from '../helpers/logger';
import { findPoolForToken, PoolMatch } from '../helpers/pool-finder';
import { fetchTokenInfo, TokenInfo } from '../analysis/token-info';
import { PriceFeed } from '../analysis/price-feed';
import { backfillCandles } from '../analysis/history-loader';
import { generateSignal, SignalConfig, DEFAULT_SIGNAL_CONFIG, Signal } from '../analysis/signal-engine';
import { Position, PositionRiskConfig } from './position';
import { TransactionExecutor } from '../transactions/transaction-executor.interface';

export interface PatternTraderConfig {
  wallet: Keypair;
  quoteToken: Token;
  quoteMint: PublicKey;
  quoteAta: PublicKey;
  quoteAmountPerPosition: BN;
  tradingTokens: PublicKey[];
  analysisIntervalMs: number;
  maxConcurrentPositions: number;
  computeUnitLimit: number;
  computeUnitPrice: number;
  maxBuyRetries: number;
  maxSellRetries: number;
  buySlippage: number;
  sellSlippage: number;
  backfillHours: number;
  signalConfig: SignalConfig;
  riskConfig: PositionRiskConfig;
}

interface TrackedToken {
  mint: PublicKey;
  mintKey: string;
  poolMatch: PoolMatch;
  info: TokenInfo;
  position?: Position;
  inFlight: boolean;
}

export class PatternTrader {
  private tracked: Map<string, TrackedToken> = new Map();
  private running: boolean = false;
  private analysisTimer: ReturnType<typeof setInterval> | undefined;
  private cycleCount: number = 0;

  constructor(
    private readonly connection: Connection,
    private readonly txExecutor: TransactionExecutor,
    private readonly priceFeed: PriceFeed,
    private readonly config: PatternTraderConfig,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    logger.info(
      { tokens: this.config.tradingTokens.map((t) => t.toBase58()) },
      'Initializing pattern trader',
    );

    // Resolve pool + metadata for each target token
    for (const mint of this.config.tradingTokens) {
      const mintKey = mint.toBase58();
      logger.info({ mint: mintKey }, 'Resolving pool and metadata...');

      const poolMatch = await findPoolForToken(this.connection, mint, this.config.quoteMint);
      if (!poolMatch) {
        logger.error({ mint: mintKey }, 'Skipping token — no Raydium pool found');
        continue;
      }

      const info = await fetchTokenInfo(this.connection, mint);

      const isToken2022 = info.tokenProgramId.equals(TOKEN_2022_PROGRAM_ID);
      logger.info(
        {
          mint: mintKey,
          name: info.name,
          symbol: info.symbol,
          decimals: info.decimals,
          renounced: info.mintAuthorityRenounced,
          freezable: !info.freezeAuthorityRenounced,
          topHolderPct: info.topHolderPercent,
          tokenProgram: isToken2022 ? 'Token-2022' : 'SPL Token',
        },
        'Token loaded',
      );

      this.tracked.set(mintKey, {
        mint,
        mintKey,
        poolMatch,
        info,
        inFlight: false,
      });
    }

    if (this.tracked.size === 0) {
      throw new Error('No tradable tokens — all pool lookups failed.');
    }

    // Detect existing token holdings so the bot can manage sells for
    // positions that were opened in a previous session (or manually).
    for (const [mintKey, token] of this.tracked) {
      try {
        const tokenProgram = token.info.tokenProgramId;
        const tokenAta = await getAssociatedTokenAddress(
          token.mint, this.config.wallet.publicKey, false, tokenProgram,
        );
        const accountInfo = await this.connection.getAccountInfo(tokenAta);
        if (!accountInfo) continue;

        const parsed = SPL_ACCOUNT_LAYOUT.decode(accountInfo.data);
        if (parsed.amount.isZero()) continue;

        const label = token.info.symbol || mintKey.slice(0, 6);
        const price = await this.priceFeed.samplePrice(
          token.poolMatch.poolKeys,
          this.config.quoteToken,
          this.config.quoteAmountPerPosition,
          token.mint,
        );

        token.position = new Position({
          mint: token.mint,
          poolKeys: token.poolMatch.poolKeys,
          tokenAta,
          entryPrice: price > 0 ? price : 0,
          entryQuoteAmount: this.config.quoteAmountPerPosition,
          tokenAmount: parsed.amount,
        });

        logger.info(
          {
            token: label,
            amount: parsed.amount.toString(),
            currentPrice: price > 0 ? price.toExponential(4) : 'unknown',
          },
          'Existing position detected in wallet',
        );
      } catch (e: any) {
        logger.warn({ mint: mintKey, error: e.message }, 'Failed to check existing balance');
      }
    }

    if (this.config.backfillHours > 0) {
      logger.info(
        { hours: this.config.backfillHours, tokens: this.tracked.size },
        'Backfilling historical candles from GeckoTerminal...',
      );
      await Promise.all(
        Array.from(this.tracked.values()).map((t) => this.backfillToken(t)),
      );
    }

    logger.info(
      { count: this.tracked.size, interval: this.config.analysisIntervalMs },
      'Pattern trader ready — starting analysis loop',
    );

    // Kick off the analysis loop
    this.analysisTimer = setInterval(() => {
      this.runCycle().catch((e) => {
        logger.error({ error: e.message }, 'Analysis cycle error');
      });
    }, this.config.analysisIntervalMs);

    // Run once immediately
    void this.runCycle();
  }

  private async backfillToken(token: TrackedToken): Promise<void> {
    const label = token.info.symbol || token.mintKey.slice(0, 6);
    try {
      const candles = await backfillCandles({
        poolAddress: token.poolMatch.poolId.toBase58(),
        symbol: label,
        hours: this.config.backfillHours,
      });

      if (candles.length === 0) {
        logger.warn(
          { token: label, mint: token.mintKey },
          'No historical candles available — will warm up from live data',
        );
        return;
      }

      this.priceFeed.seedHistory(token.mintKey, candles);

      // Sample live price to normalize seeded history into the same units
      // as on-chain pool simulation, so live data joins continuously.
      const livePrice = await this.priceFeed.samplePrice(
        token.poolMatch.poolKeys,
        this.config.quoteToken,
        this.config.quoteAmountPerPosition,
        token.mint,
      );
      if (livePrice > 0) {
        const ratio = this.priceFeed.normalizeHistoryTo(token.mintKey, livePrice);
        if (ratio !== null && Math.abs(ratio - 1) >= 0.05) {
          logger.info(
            { token: label, ratio: ratio.toExponential(3) },
            'Rescaled historical candles to match live pool price',
          );
        }
      }

      const first = candles[0];
      const last = candles[candles.length - 1];
      const spanHours = (last.timestamp - first.timestamp) / 3_600_000;
      logger.info(
        {
          token: label,
          candles: candles.length,
          spanHours: spanHours.toFixed(1),
          oldest: new Date(first.timestamp).toISOString(),
          newest: new Date(last.timestamp).toISOString(),
        },
        'Chart history loaded',
      );
    } catch (e: any) {
      logger.warn(
        { token: label, error: e.message },
        'Historical backfill failed — will warm up from live data',
      );
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.analysisTimer) {
      clearInterval(this.analysisTimer);
      this.analysisTimer = undefined;
    }
    logger.info('Pattern trader stopped');
  }

  private async runCycle(): Promise<void> {
    const tokens = Array.from(this.tracked.values());
    logger.info({ tokens: tokens.length, cycle: ++this.cycleCount }, 'Cycle start');

    const tasks = tokens.map((token) =>
      this.analyzeToken(token).catch((e) => {
        logger.error({ error: e.message, mint: token.mintKey }, 'Token analysis error');
      }),
    );
    await Promise.all(tasks);
  }

  private async analyzeToken(token: TrackedToken): Promise<void> {
    if (token.inFlight) return;

    // Sample the pool — price + volume
    const price = await this.priceFeed.samplePrice(
      token.poolMatch.poolKeys,
      this.config.quoteToken,
      this.config.quoteAmountPerPosition,
      token.mint,
    );

    if (price <= 0) {
      logger.warn({ mint: token.mintKey, symbol: token.info.symbol }, 'Price sample returned 0, skipping');
      return;
    }

    const volume = await this.priceFeed.sampleVolume(token.poolMatch.poolKeys, token.mintKey, token.mint);
    this.priceFeed.recordPrice(token.mintKey, price, volume);

    const candles = this.priceFeed.getCandles(token.mintKey);
    const holding = !!token.position;
    const signal = generateSignal(candles, this.config.signalConfig, holding);

    const label = token.info.symbol || token.mintKey.slice(0, 6);
    logger.info(
      {
        token: label,
        price: price.toExponential(4),
        candles: candles.length,
        rsi: signal.indicators.rsi?.toFixed(1),
        macdHist: signal.indicators.macdHistogram?.toExponential(2),
        trend1m: signal.indicators.trend,
        trend5m: signal.indicators.trend5m,
        trend15m: signal.indicators.trend15m,
        trend1h: signal.indicators.trend1h,
        action: signal.action,
        confidence: signal.confidence,
        reasons: signal.action !== 'HOLD' ? signal.reasons : undefined,
      },
      'analysis',
    );

    if (token.position) {
      // Exit logic: combine risk-based and signal-based exits
      const riskReason = token.position.evaluateRisk(price, this.config.riskConfig);
      if (riskReason) {
        logger.info({ token: label, reason: riskReason, pnl: token.position.pnlPercent(price).toFixed(2) + '%' }, 'Risk exit triggered');
        token.inFlight = true;
        try {
          await this.sell(token, signal);
        } finally {
          token.inFlight = false;
        }
        return;
      }

      if (signal.action === 'SELL') {
        logger.info(
          { token: label, confidence: signal.confidence, reasons: signal.reasons, pnl: token.position.pnlPercent(price).toFixed(2) + '%' },
          'Signal exit triggered',
        );
        token.inFlight = true;
        try {
          await this.sell(token, signal);
        } finally {
          token.inFlight = false;
        }
      }
      return;
    }

    // Entry logic
    if (signal.action !== 'BUY') return;

    // Respect max concurrent positions
    const activePositions = Array.from(this.tracked.values()).filter((t) => t.position).length;
    if (activePositions >= this.config.maxConcurrentPositions) {
      logger.debug({ active: activePositions }, 'Max concurrent positions reached, skipping buy');
      return;
    }

    logger.info(
      { token: label, confidence: signal.confidence, reasons: signal.reasons, price: price.toExponential(4) },
      'Signal entry triggered',
    );

    token.inFlight = true;
    try {
      await this.buy(token, price, signal);
    } finally {
      token.inFlight = false;
    }
  }

  private async buy(token: TrackedToken, price: number, signal: Signal): Promise<void> {
    const poolKeys = token.poolMatch.poolKeys;
    const tokenProgram = token.info.tokenProgramId;
    const tokenAta = await getAssociatedTokenAddress(
      token.mint, this.config.wallet.publicKey, false, tokenProgram,
    );

    for (let attempt = 1; attempt <= this.config.maxBuyRetries; attempt++) {
      try {
        const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
          {
            poolKeys,
            userKeys: {
              tokenAccountIn: this.config.quoteAta,
              tokenAccountOut: tokenAta,
              owner: this.config.wallet.publicKey,
            },
            amountIn: this.config.quoteAmountPerPosition,
            minAmountOut: new BN(0),
          },
          poolKeys.version,
        );

        // SDK hardcodes TOKEN_PROGRAM_ID at account [0] — patch it for Token-2022
        if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
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
          token.mint,
          tokenProgram,
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
                lamports: this.config.quoteAmountPerPosition.toNumber(),
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
          // Read actual balance to record true token amount received
          const accountInfo = await this.connection.getAccountInfo(tokenAta);
          let tokenAmount = new BN(0);
          if (accountInfo) {
            const parsed = SPL_ACCOUNT_LAYOUT.decode(accountInfo.data);
            tokenAmount = parsed.amount;
          }

          token.position = new Position({
            mint: token.mint,
            poolKeys,
            tokenAta,
            entryPrice: price,
            entryQuoteAmount: this.config.quoteAmountPerPosition,
            tokenAmount,
          });

          logger.info(
            {
              token: token.info.symbol || token.mintKey.slice(0, 6),
              signature: result.signature,
              entryPrice: price.toExponential(4),
              dexscreener: `https://dexscreener.com/solana/${token.mintKey}`,
            },
            'Buy filled',
          );
          return;
        }

        logger.warn({ attempt, error: result.error }, 'Buy attempt failed');
      } catch (e: any) {
        logger.error({ error: e.message, attempt }, 'Buy error');
      }
    }

    logger.error({ token: token.mintKey }, 'All buy attempts failed');
  }

  private async sell(token: TrackedToken, signal: Signal): Promise<void> {
    if (!token.position) return;

    const position = token.position;
    const poolKeys = position.poolKeys;

    // Refresh actual on-chain balance before selling
    const accountInfo = await this.connection.getAccountInfo(position.tokenAta);
    if (!accountInfo) {
      logger.warn({ token: token.mintKey }, 'Token account missing, closing position');
      token.position = undefined;
      this.priceFeed.reset(token.mintKey);
      return;
    }
    const parsed = SPL_ACCOUNT_LAYOUT.decode(accountInfo.data);
    const sellAmount = parsed.amount;

    if (sellAmount.isZero()) {
      logger.info({ token: token.mintKey }, 'Token balance is zero, closing position');
      token.position = undefined;
      this.priceFeed.reset(token.mintKey);
      return;
    }

    const tokenProgram = token.info.tokenProgramId;

    for (let attempt = 1; attempt <= this.config.maxSellRetries; attempt++) {
      try {
        const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
          {
            poolKeys,
            userKeys: {
              tokenAccountIn: position.tokenAta,
              tokenAccountOut: this.config.quoteAta,
              owner: this.config.wallet.publicKey,
            },
            amountIn: sellAmount,
            minAmountOut: new BN(0),
          },
          poolKeys.version,
        );

        // SDK hardcodes TOKEN_PROGRAM_ID at account [0] — patch it for Token-2022
        if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
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
              token: token.info.symbol || token.mintKey.slice(0, 6),
              signature: result.signature,
              heldMs: position.ageMs,
            },
            'Sell filled',
          );
          token.position = undefined;
          this.priceFeed.reset(token.mintKey);
          return;
        }

        logger.warn({ attempt, error: result.error }, 'Sell attempt failed');
      } catch (e: any) {
        logger.error({ error: e.message, attempt }, 'Sell error');
      }
    }

    logger.error({ token: token.mintKey }, 'All sell attempts failed');
  }

  getStatus(): Record<string, any> {
    const status: Record<string, any> = {};
    for (const [key, token] of this.tracked) {
      const candles = this.priceFeed.getCandleCount(key);
      status[token.info.symbol || key.slice(0, 6)] = {
        mint: key,
        candles,
        position: token.position
          ? {
              entry: token.position.entryPrice,
              peak: token.position.peak,
              ageMs: token.position.ageMs,
            }
          : null,
      };
    }
    return status;
  }
}
