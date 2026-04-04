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

// Jito tip accounts — one is randomly selected per bundle
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4bVqkfRtQ7NmXwkiNPLYkNB',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSPi7M6aQQSJHKFVYcH',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

const JITO_BLOCK_ENGINE_URL = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';

export class JitoTransactionExecutor implements TransactionExecutor {
  constructor(
    private readonly connection: Connection,
    private readonly wallet: Keypair,
    private readonly tipAmount: number,
  ) {}

  async executeAndConfirm(
    transaction: Transaction | VersionedTransaction,
    latestBlockhash: BlockhashWithExpiryBlockHeight,
  ): Promise<{ confirmed: boolean; signature?: string; error?: string }> {
    logger.debug('Executing transaction with Jito executor...');

    try {
      // Create tip transaction
      const tipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
      const tipLamports = Math.round(this.tipAmount * LAMPORTS_PER_SOL);

      const tipInstruction = SystemProgram.transfer({
        fromPubkey: this.wallet.publicKey,
        toPubkey: new PublicKey(tipAccount),
        lamports: tipLamports,
      });

      const tipMessage = new TransactionMessage({
        payerKey: this.wallet.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: [tipInstruction],
      }).compileToV0Message();

      const tipTransaction = new VersionedTransaction(tipMessage);
      tipTransaction.sign([this.wallet]);

      const serializedTransaction = Buffer.from((transaction as VersionedTransaction).serialize()).toString('base64');
      const serializedTipTransaction = Buffer.from(tipTransaction.serialize()).toString('base64');

      // Send bundle via Jito JSON-RPC
      const response = await fetch(JITO_BLOCK_ENGINE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sendBundle',
          params: [[serializedTransaction, serializedTipTransaction]],
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        return { confirmed: false, error: `Jito API error: ${response.status} - ${text}` };
      }

      const result = await response.json() as any;

      if (result.error) {
        return { confirmed: false, error: `Jito error: ${JSON.stringify(result.error)}` };
      }

      const bundleId = result.result;
      logger.debug({ bundleId }, 'Jito bundle sent');

      // Try to get the transaction signature from the bundle
      // The main transaction signature can be derived from the versioned transaction
      const txSignature = Buffer.from(
        (transaction as VersionedTransaction).signatures[0],
      ).toString('base64');

      // Convert to base58 for confirmation
      const bs58 = await import('bs58');
      const signatureBase58 = bs58.default.encode(
        (transaction as VersionedTransaction).signatures[0],
      );

      const confirmation = await this.connection.confirmTransaction(
        {
          signature: signatureBase58,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
          blockhash: latestBlockhash.blockhash,
        },
        this.connection.commitment,
      );

      if (confirmation.value.err) {
        return {
          confirmed: false,
          error: `Jito bundle transaction failed: ${JSON.stringify(confirmation.value.err)}`,
        };
      }

      return { confirmed: true, signature: signatureBase58 };
    } catch (e: any) {
      logger.debug({ error: e.message }, 'Jito executor error');
      return { confirmed: false, error: e.message };
    }
  }
}
