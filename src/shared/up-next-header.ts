/**
 * The one line under UP NEXT: what the run is doing, read from the ONE policy
 * (`session-run-lifecycle.ts`) and from nothing else. A stopped run says WHY by class —
 * recovering, waiting, needs you, failed — and "needs you" exists only with the open requests
 * that say what the person must provide (`docs/reference/session-run-lifecycle.md`).
 */

import type { HumanAttentionRequest } from './session-human-attention'
import type { SessionRunDisposition } from './session-run-completion'
import type { UpNextAgentBlock, UpNextBlock } from './up-next-types'

/**
 * `completed` is a proven run whose session is still there; `closed` is one whose session the
 * person asked to close AND a window reported closed. Nothing is "closed" by finishing.
 */
export type UpNextHeaderState =
  | 'running'
  | 'idle'
  | 'recovering'
  | 'waiting'
  | 'needs-you'
  | 'failed'
  | 'completed'
  | 'closed'

/** One open request to the owner, with the direct way to meet it. */
export type UpNextAttention = Pick<HumanAttentionRequest, 'id' | 'kind' | 'ask' | 'why' | 'action'>

/** What became of the session after its run completed; absent when nothing was asked of it. */
export type UpNextDisposition = {
  intent: 'close' | 'save'
  state: SessionRunDisposition['state']
  folderId?: string
  appliedAt?: number
  /** Why the last close or save did not happen. A diagnostic, shown under Details. */
  error?: string
}

export type UpNextHeader = {
  state: UpNextHeaderState
  /** Which stage the track is at, when one is running or stopped. */
  stage?: { n: number; of: number }
  /** `needs-you`: every valid open request addressed to the owner. */
  attention?: UpNextAttention[]
  /** `failed`: a machine code, and the raw diagnostic that belongs under Details. */
  failure?: { code: string; reason?: string }
  /** `recovering`: when the host next acts by itself. */
  recoveringUntil?: number
  /** `waiting`: what the run is waiting for — a person's name, evidence, the execution host. */
  wake?: string
  /** `completed` and `closed`: when the run was sealed. */
  completedAt?: number
  disposition?: UpNextDisposition
  /** `closed` only: when a window reported the session closed. */
  closedAt?: number
}

/** A finished run takes nothing more, whether or not its session was also closed. */
export function upNextIsFinished(state: UpNextHeaderState): boolean {
  return state === 'completed' || state === 'closed'
}

/** The header states of a run that stopped before it finished. */
export function upNextIsStoppedHeader(state: UpNextHeaderState): boolean {
  return (
    state === 'recovering' || state === 'waiting' || state === 'needs-you' || state === 'failed'
  )
}

/** The readings of a stage the track stopped at; `waiting` is one only when it carries a stop. */
export function upNextIsStoppedStage(block: UpNextBlock): block is UpNextAgentBlock {
  if (block.kind !== 'agent') {
    return false
  }
  return (
    block.state === 'recovering' ||
    block.state === 'needs-you' ||
    block.state === 'failed' ||
    (block.state === 'waiting' && block.progress?.stoppedAt !== undefined)
  )
}
