/**
 * The Up next header of a pursued conversation, read from the ONE policy.
 *
 * `readSessionRun` decides the phase (`docs/reference/session-run-lifecycle.md`); this only says
 * it in the header's words. Nothing here looks at a blocked reason, an attempt error or a stopped
 * stage to decide anything: "needs you" is the open requests addressed to the owner, "closed" is
 * a close a window REPORTED applied, and a finished run with no terminal action is Completed.
 */

import type { SessionChain } from '../../shared/session-chain-types'
import { UNCLASSIFIED_BLOCK_CODE } from '../../shared/session-outcome-block'
import { readSessionRun, type SessionRunReading } from '../../shared/session-run-lifecycle'
import type { UpNextDisposition, UpNextHeader } from '../../shared/up-next-types'

/** Close and Save are asked of a window; `completed` asks nothing, so it is not a disposition here. */
function dispositionOf(run: SessionRunReading): UpNextDisposition | undefined {
  const disposition = run.disposition
  if (!disposition || disposition.intent === 'completed') {
    return undefined
  }
  return {
    intent: disposition.intent,
    state: disposition.state,
    ...(disposition.folderId ? { folderId: disposition.folderId } : {}),
    ...(disposition.appliedAt !== undefined ? { appliedAt: disposition.appliedAt } : {}),
    ...(disposition.state !== 'applied' && disposition.lastError
      ? { error: disposition.lastError }
      : {})
  }
}

function completedHeader(run: SessionRunReading): UpNextHeader {
  const disposition = dispositionOf(run)
  const sealed = run.completion ? { completedAt: run.completion.at } : {}
  if (disposition?.intent === 'close' && disposition.state === 'applied') {
    return {
      state: 'closed',
      ...sealed,
      disposition,
      ...(disposition.appliedAt !== undefined ? { closedAt: disposition.appliedAt } : {})
    }
  }
  return { state: 'completed', ...sealed, ...(disposition ? { disposition } : {}) }
}

/** The header the run's phase decides, or null while it is `active` and the view reads what is in flight. */
export function upNextRunHeader(chain: SessionChain, now: number): UpNextHeader | null {
  const set = chain.outcomeSet
  if (!set) {
    return null
  }
  const run = readSessionRun(set, { now, planVersion: chain.planVersion ?? 1 })
  switch (run.phase) {
    case 'completed':
      return completedHeader(run)
    case 'needs-you':
      return {
        state: 'needs-you',
        attention: run.attention.map((request) => ({
          id: request.id,
          kind: request.kind,
          ask: request.ask,
          why: request.why,
          ...(request.action ? { action: request.action } : {})
        }))
      }
    case 'recovering':
      return {
        state: 'recovering',
        ...(run.recoveringUntil !== undefined ? { recoveringUntil: run.recoveringUntil } : {})
      }
    case 'waiting':
      return { state: 'waiting', ...(run.wake ? { wake: run.wake } : {}) }
    case 'failed':
      return {
        state: 'failed',
        failure: {
          code: run.failure?.code ?? UNCLASSIFIED_BLOCK_CODE,
          ...(run.failure?.reason ? { reason: run.failure.reason } : {})
        }
      }
    case 'active':
      return null
  }
}
