import { Connection, PublicKey } from '@solana/web3.js';
import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { Filter, FilterResult } from './filter.interface';
import { logger } from '../helpers/logger';

const METAPLEX_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

export class SocialsFilter implements Filter {
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

      const data = accountInfo.data;

      // Parse to find URI
      let offset = 1 + 32 + 32; // key + updateAuthority + mint

      // name
      const nameLen = data.readUInt32LE(offset);
      offset += 4 + nameLen;

      // symbol
      const symbolLen = data.readUInt32LE(offset);
      offset += 4 + symbolLen;

      // uri
      const uriLen = data.readUInt32LE(offset);
      offset += 4;
      const uri = data.slice(offset, offset + uriLen).toString('utf-8').replace(/\0/g, '').trim();

      if (!uri || uri.length === 0) {
        return { ok: false, message: 'No metadata URI found' };
      }

      // Fetch the metadata JSON to check for social links
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      try {
        const response = await fetch(uri, { signal: controller.signal });
        clearTimeout(timeout);

        if (!response.ok) {
          return { ok: false, message: `Failed to fetch metadata: ${response.status}` };
        }

        const metadata = await response.json() as Record<string, any>;

        // Check for social links in extensions or properties
        const hasSocials =
          metadata.external_url ||
          metadata.twitter ||
          metadata.telegram ||
          metadata.website ||
          metadata.discord ||
          (metadata.extensions &&
            (metadata.extensions.twitter ||
              metadata.extensions.telegram ||
              metadata.extensions.website ||
              metadata.extensions.discord));

        if (hasSocials) {
          return { ok: true, message: 'Token has social links' };
        }

        return { ok: false, message: 'No social links found in metadata' };
      } catch (fetchError) {
        clearTimeout(timeout);
        return { ok: false, message: 'Failed to fetch metadata JSON' };
      }
    } catch (e: any) {
      logger.error({ error: e.message }, 'SocialsFilter error');
      return { ok: false, message: `SocialsFilter error: ${e.message}` };
    }
  }
}
