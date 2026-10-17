/**
 * `omni session resume|pending` and `session continue --prompt … --when-idle`: reusing past and
 * busy sessions instead of launching new ones. Each is one `sessionManage.*` call.
 */

import { SESSION_MANAGE_RPC } from '../../shared/session-manage-types'
import {
  parseSessionWhenIdleWindow,
  SESSION_WHEN_IDLE_MAX_MS,
  type SessionContinueWhenIdleResult,
  type SessionPendingDelivery,
  type SessionPendingListResult
} from '../../shared/session-pending-delivery-types'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import type { SessionResumeResult } from '../../shared/session-resume-types'
import {
  formatSessionPending,
  formatSessionResume,
  formatSessionWhenIdle
} from '../session-reuse-format'
import { refuseRemote } from './session-manage-access'
import type { SessionTarget } from './session-folder-target'
import { sessionProvenance } from './session-provenance-flags'

const RESUME_TIMEOUT_MS = 180_000
/** The held call's own budget beyond its window: reading the target and sending take time. */
const WHEN_IDLE_GRACE_MS = 60_000

/** `--when-idle [--within] [--wait]` on `session continue`; only a --prompt can be held. */
export function whenIdleOptions(
  flags: HandlerContext['flags']
): { withinMs?: number; wait: boolean } | null {
  const within = getOptionalStringFlag(flags, 'within')
  const wait = flags.get('wait') === true
  if (flags.get('when-idle') !== true) {
    if (within !== undefined || wait) {
      throw new RuntimeClientError('invalid_argument', '--within and --wait go with --when-idle.')
    }
    return null
  }
  const withinMs = within === undefined ? undefined : parseSessionWhenIdleWindow(within)
  if (withinMs === null) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--within takes a window from 1m to 4h, such as 30m, 2h or 90s.'
    )
  }
  return { ...(withinMs !== undefined ? { withinMs } : {}), wait }
}

export async function continueWhenIdle(
  { client, flags, json }: HandlerContext,
  target: SessionTarget,
  text: string,
  options: { withinMs?: number; wait: boolean },
  kind: 'continue' | 'assign' = 'continue'
): Promise<void> {
  const response = await client.call<SessionContinueWhenIdleResult>(
    SESSION_MANAGE_RPC.continueWhenIdle,
    {
      target,
      text,
      ...(kind === 'assign' ? { kind } : {}),
      ...(options.withinMs !== undefined ? { withinMs: options.withinMs } : {}),
      ...(options.wait ? { wait: true } : {}),
      ...sessionProvenance(flags)
    },
    options.wait
      ? { timeoutMs: (options.withinMs ?? SESSION_WHEN_IDLE_MAX_MS) + WHEN_IDLE_GRACE_MS }
      : undefined
  )
  printResult(response, json, formatSessionWhenIdle)
  const held: SessionPendingDelivery | undefined = response.result.pending
  if (options.wait && held && held.state !== 'delivered' && !response.result.dryRun) {
    process.exitCode = 1
  }
}

export const SESSION_REUSE_HANDLERS: Record<string, CommandHandler> = {
  'session resume': async ({ client, flags, json }) => {
    refuseRemote(client)
    const ref = getRequiredStringFlag(flags, 'ref')
    const response = await client.call<SessionResumeResult>(
      SESSION_MANAGE_RPC.resume,
      { ref, ...sessionProvenance(flags) },
      { timeoutMs: RESUME_TIMEOUT_MS }
    )
    printResult(response, json, formatSessionResume)
  },
  'session pending': async ({ client, flags, json }) => {
    refuseRemote(client)
    const cancel = getOptionalStringFlag(flags, 'cancel')
    const response = await client.call<SessionPendingListResult>(SESSION_MANAGE_RPC.pending, {
      ...(flags.get('all') === true ? { all: true } : {}),
      ...(cancel ? { cancel } : {})
    })
    printResult(response, json, formatSessionPending)
  }
}
