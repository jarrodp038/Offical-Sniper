import {
  Connection,
  Keypair,
  Transaction,
  VersionedTransaction,
  BlockhashWithExpiryBlockHeight,
  SystemProgram,
  PublicKey,
  TransactionMessage,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { TransactionExecutor } from './transaction-executor.interface';
import { logger } from '../helpers/logger';

const WARP_API_URL = 'https://tx.warp.id/transaction/execute';

export class WarpTransactionExecutor implements TransactionExecutor {
  constructor(
    private readonly connection: Connection,
    private readonly wallet: Keypair,
    private readonly feeAmount: number,
  ) {}

  async executeAndConfirm(
    transaction: Transaction | VersionedTransaction,
    latestBlockhash: BlockhashWithExpiryBlockHeight,
  ): Promise<{ confirmed: boolean; signature?: string; error?: string }> {
    logger.debug('Executing transaction with Warp executor...');

    try {
      // Create fee transaction signed locally — NEVER send private key
      const feeLamports = Math.round(this.feeAmount * LAMPORTS_PER_SOL);
      const feeInstruction = SystemProgram.transfer({
        fromPubkey: this.wallet.publicKey,
        toPubkey: new PublicKey('WARPzUMPnycu9eeCZ95rcAUxorqpBqHndfV3ZBrFwFh'),
        lamports: feeLamports,
      });

      const feeMessage = new TransactionMessage({
        payerKey: this.wallet.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: [feeInstruction],
      }).compileToV0Message();

      const feeTransaction = new VersionedTransaction(feeMessage);
      feeTransaction.sign([this.wallet]);

      const serializedTransaction = Buffer.from((transaction as VersionedTransaction).serialize()).toString('base64');
      const serializedFeeTransaction = Buffer.from(feeTransaction.serialize()).toString('base64');

      const response = await fetch(WARP_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transaction: serializedTransaction,
          feeTransaction: serializedFeeTransaction,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        return { confirmed: false, error: `Warp API error: ${response.status} - ${text}` };
      }

      const result = await response.json() as any;

      if (result.signature) {
        logger.debug({ signature: result.signature }, 'Warp transaction sent');

        const confirmation = await this.connection.confirmTransaction(
          {
            signature: result.signature,
            lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
            blockhash: latestBlockhash.blockhash,
          },
          this.connection.commitment,
        );

        if (confirmation.value.err) {
          return { confirmed: false, error: `Warp transaction failed: ${JSON.stringify(confirmation.value.err)}` };
        }

        return { confirmed: true, signature: result.signature };
      }

      return { confirmed: false, error: 'No signature returned from Warp' };
    } catch (e: any) {
      logger.debug({ error: e.message }, 'Warp executor error');
      return { confirmed: false, error: e.message };
    }
  }
}
