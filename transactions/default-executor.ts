import {
  Connection,
  Keypair,
  Transaction,
  VersionedTransaction,
  BlockhashWithExpiryBlockHeight,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedMessage,
} from '@solana/web3.js';
import { TransactionExecutor } from './transaction-executor.interface';
import { logger } from '../helpers/logger';

export class DefaultTransactionExecutor implements TransactionExecutor {
  constructor(
    private readonly connection: Connection,
    private readonly wallet: Keypair,
    private readonly computeUnitLimit: number,
    private readonly computeUnitPrice: number,
  ) {}

  async executeAndConfirm(
    transaction: Transaction | VersionedTransaction,
    latestBlockhash: BlockhashWithExpiryBlockHeight,
  ): Promise<{ confirmed: boolean; signature?: string; error?: string }> {
    logger.debug('Executing transaction with default executor...');

    try {
      const signature = await this.connection.sendTransaction(transaction as VersionedTransaction, {
        preflightCommitment: this.connection.commitment,
        maxRetries: 5,
      });

      logger.debug({ signature }, 'Transaction sent');

      const confirmation = await this.connection.confirmTransaction(
        {
          signature,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
          blockhash: latestBlockhash.blockhash,
        },
        this.connection.commitment,
      );

      if (confirmation.value.err) {
        logger.debug({ error: confirmation.value.err }, 'Transaction failed');
        return { confirmed: false, error: `Transaction failed: ${JSON.stringify(confirmation.value.err)}` };
      }

      return { confirmed: true, signature };
    } catch (e: any) {
      logger.debug({ error: e.message }, 'Transaction execution error');
      return { confirmed: false, error: e.message };
    }
  }

  prepareTransaction(
    instructions: any[],
    payer: Keypair,
    recentBlockhash: string,
  ): VersionedTransaction {
    const computeBudgetIxs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: this.computeUnitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.computeUnitPrice }),
    ];

    const allInstructions = [...computeBudgetIxs, ...instructions];

    const messageV0 = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash,
      instructions: allInstructions,
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);
    tx.sign([payer]);

    return tx;
  }
}
