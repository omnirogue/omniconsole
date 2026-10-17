import { sessionManageHostKey } from '../../shared/session-manage-query'
import { RuntimeClientError } from '../runtime-client'

/** `--host local|ssh:<id>|runtime:<id>` as the runtime's host key; refuses anything else. */
export function parseHost(raw: string | undefined): string | undefined {
  const hostId = raw === undefined ? undefined : sessionManageHostKey(raw)
  if (raw !== undefined && !hostId) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Use --host local, ssh:<id> or runtime:<id>. Read omni host list for target identities.'
    )
  }
  return hostId ?? undefined
}
