import type { HandlerContext } from '../dispatch'
import { getOptionalStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime/types'

/** `--reason`, `--request` and `--dry-run`, as every mutating session and folder command takes them. */
export function sessionProvenance(flags: HandlerContext['flags']): {
  reason?: string
  request?: string
  dryRun?: true
} {
  if (typeof flags.get('dry-run') === 'string') {
    throw new RuntimeClientError('invalid_argument', 'Pass --dry-run without a value.')
  }
  const reason = getOptionalStringFlag(flags, 'reason')?.trim()
  const request = getOptionalStringFlag(flags, 'request')?.trim()
  return {
    ...(reason ? { reason } : {}),
    ...(request ? { request } : {}),
    ...(flags.get('dry-run') === true ? { dryRun: true as const } : {})
  }
}
