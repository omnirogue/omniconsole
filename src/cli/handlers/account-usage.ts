import { isAbsolute } from 'node:path'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime/types'

export const ACCOUNT_USAGE_HANDLERS: Record<string, CommandHandler> = {
  'account usage': async ({ client, flags, json }) => {
    for (const flag of ['environment', 'pairing-code']) {
      if (flags.has(flag)) {
        throw new RuntimeClientError(
          'invalid_argument',
          `\`--${flag}\` does not retarget \`omni account usage\`. Run it on the host whose account you want to inspect.`
        )
      }
    }
    const inputFile = flags.get('input-file')
    if (
      typeof inputFile !== 'string' ||
      !isAbsolute(inputFile) ||
      inputFile.length > 4_096 ||
      inputFile.includes('\0')
    ) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--input-file must name an absolute private JSON request file.'
      )
    }
    const result = await client.call<ProviderRateLimits>(
      'accounts.probeSelectedUsage',
      { inputFile },
      { timeoutMs: 22_000 }
    )
    printResult(result, json, (usage) => JSON.stringify(usage, null, 2))
  }
}
