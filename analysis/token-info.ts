import { Connection, PublicKey } from '@solana/web3.js';
import { getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { logger } from '../helpers/logger';

const METAPLEX_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

export interface TokenInfo {
  mint: string;
  name?: string;
  symbol?: string;
  uri?: string;
  decimals: number;
  supply: string;
  mintAuthorityRenounced: boolean;
  freezeAuthorityRenounced: boolean;
  topHolderPercent: number | null;
  holderCount: number | null;
  tokenProgramId: PublicKey;
}

export async function fetchTokenInfo(
  connection: Connection,
  mint: PublicKey,
): Promise<TokenInfo> {
  // Detect token program by checking mint account owner
  let tokenProgramId: PublicKey = TOKEN_PROGRAM_ID;
  try {
    const mintAccountInfo = await connection.getAccountInfo(mint);
    if (mintAccountInfo && mintAccountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      tokenProgramId = TOKEN_2022_PROGRAM_ID;
    }
  } catch (e: any) {
    logger.debug({ error: e.message }, 'Failed to detect token program');
  }

  const info: TokenInfo = {
    mint: mint.toBase58(),
    decimals: 0,
    supply: '0',
    mintAuthorityRenounced: false,
    freezeAuthorityRenounced: false,
    topHolderPercent: null,
    holderCount: null,
    tokenProgramId,
  };

  // Mint account data
  try {
    const mintInfo = await getMint(connection, mint, undefined, tokenProgramId);
    info.decimals = mintInfo.decimals;
    info.supply = mintInfo.supply.toString();
    info.mintAuthorityRenounced = mintInfo.mintAuthority === null;
    info.freezeAuthorityRenounced = mintInfo.freezeAuthority === null;
  } catch (e: any) {
    logger.debug({ error: e.message }, 'Failed to fetch mint info');
  }

  // Metaplex metadata
  try {
    const [metadataPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('metadata'), METAPLEX_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      METAPLEX_PROGRAM_ID,
    );

    const account = await connection.getAccountInfo(metadataPDA);
    if (account) {
      const data = account.data;
      let offset = 1 + 32 + 32; // key + updateAuthority + mint

      const nameLen = data.readUInt32LE(offset);
      offset += 4;
      info.name = data.slice(offset, offset + nameLen).toString('utf-8').replace(/\0/g, '').trim();
      offset += nameLen;

      const symbolLen = data.readUInt32LE(offset);
      offset += 4;
      info.symbol = data.slice(offset, offset + symbolLen).toString('utf-8').replace(/\0/g, '').trim();
      offset += symbolLen;

      const uriLen = data.readUInt32LE(offset);
      offset += 4;
      info.uri = data.slice(offset, offset + uriLen).toString('utf-8').replace(/\0/g, '').trim();
    }
  } catch (e: any) {
    logger.debug({ error: e.message }, 'Failed to fetch metadata');
  }

  // Top holder distribution
  try {
    const largest = await connection.getTokenLargestAccounts(mint);
    const totalSupply = BigInt(info.supply);

    if (totalSupply > BigInt(0) && largest.value.length > 0) {
      const top = BigInt(largest.value[0].amount);
      info.topHolderPercent = Number((top * BigInt(10000)) / totalSupply) / 100;
      info.holderCount = largest.value.filter((a) => BigInt(a.amount) > BigInt(0)).length;
    }
  } catch (e: any) {
    logger.debug({ error: e.message }, 'Failed to fetch holder data');
  }

  return info;
}
