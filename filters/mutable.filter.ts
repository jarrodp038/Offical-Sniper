import { Connection, PublicKey } from '@solana/web3.js';
import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { Filter, FilterResult } from './filter.interface';
import { logger } from '../helpers/logger';

const METAPLEX_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

export class MutableFilter implements Filter {
  constructor(private readonly connection: Connection) {}

  async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    try {
      const [metadataPDA] = PublicKey.findProgramAddressSync(
        [
          Buffer.from('metadata'),
          METAPLEX_PROGRAM_ID.toBuffer(),
          poolKeys.baseMint.toBuffer(),
        ],
        METAPLEX_PROGRAM_ID,
      );

      const accountInfo = await this.connection.getAccountInfo(metadataPDA);

      if (!accountInfo) {
        return { ok: false, message: 'Metadata account not found' };
      }

      // In Metaplex metadata layout, the isMutable flag is the last byte of the
      // fixed-size header (offset varies, but we check the standard position).
      // For Token Metadata v1.1+, isMutable is at a known offset.
      // A simpler heuristic: check byte at offset 1 + 32 + 32 + ...
      // The isMutable field is a single byte near the end of the core data.
      const data = accountInfo.data;

      // Parse the metadata account data
      // Key (1) + UpdateAuthority (32) + Mint (32) = offset 65 for name
      // Then: name (4 + 32) + symbol (4 + 10) + uri (4 + 200) + sellerFeeBasisPoints (2) + creators option...
      // isMutable is a boolean at a variable position. Use a reliable detection:
      // Read from the end area. The primarySaleHappened and isMutable flags are at predictable offsets.

      // Standard Metaplex v1 layout parsing:
      let offset = 1 + 32 + 32; // key + updateAuthority + mint

      // name: 4-byte length prefix + content
      const nameLen = data.readUInt32LE(offset);
      offset += 4 + nameLen;

      // symbol: 4-byte length prefix + content
      const symbolLen = data.readUInt32LE(offset);
      offset += 4 + symbolLen;

      // uri: 4-byte length prefix + content
      const uriLen = data.readUInt32LE(offset);
      offset += 4 + uriLen;

      // seller_fee_basis_points: u16
      offset += 2;

      // creators: Option<Vec<Creator>>
      const hasCreators = data.readUInt8(offset);
      offset += 1;

      if (hasCreators) {
        const creatorsLen = data.readUInt32LE(offset);
        offset += 4;
        // Each creator: pubkey(32) + verified(1) + share(1) = 34 bytes
        offset += creatorsLen * 34;
      }

      // primarySaleHappened: bool
      offset += 1;

      // isMutable: bool
      const isMutable = data.readUInt8(offset) === 1;

      if (isMutable) {
        return { ok: false, message: 'Token metadata is mutable' };
      }

      return { ok: true, message: 'Token metadata is immutable' };
    } catch (e: any) {
      logger.error({ error: e.message }, 'MutableFilter error');
      return { ok: false, message: `MutableFilter error: ${e.message}` };
    }
  }
}
