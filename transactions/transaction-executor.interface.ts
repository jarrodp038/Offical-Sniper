import { Transaction, VersionedTransaction, BlockhashWithExpiryBlockHeight } from '@solana/web3.js';

export interface TransactionExecutor {
  executeAndConfirm(
    transaction: Transaction | VersionedTransaction,
    latestBlockhash: BlockhashWithExpiryBlockHeight,
  ): Promise<{ confirmed: boolean; signature?: string; error?: string }>;
}
