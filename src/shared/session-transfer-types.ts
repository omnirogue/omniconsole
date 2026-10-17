import type { SessionManageActionResult } from './session-manage-types'

export type SessionTransferIdentity = { paneKey: string | null; title: string }
export type SessionArchiveOutcome =
  | { status: 'archived' }
  | { status: 'not-archived' | 'unknown'; reason: string }
/** The other computer a `--host` move targets: where the new session runs and what it starts from. */
export type SessionTransferHost = {
  hostId: string
  label: string
  workspace?: { id: string; path: string; branch: string | null }
  /** Each git source's branch as it stood on its remote when the target was started. */
  branches?: { title: string; branch: string; upstream: string; head: string | null }[]
  /** `unverifiable` when that computer cannot be reached: never read as moved or as stopped. */
  verdict?: 'live' | 'unverifiable'
}
/**
 * A source that runs under a session host (another computer, or this one's own registry): settled
 * at that host, one receipt each. `unresolved`: its host did not answer, so its reservation may
 * still hold there; continuing the transfer settles it with the same request, never a new brief.
 */
export type SessionTransferHostSourceReceipt = {
  hostId: string
  label: string
  conversationId: string
  title: string
  state: 'archived' | 'kept' | 'released' | 'unresolved'
  detail?: string
}
export type SessionTransferResult = SessionManageActionResult & {
  outcome: 'planned' | 'completed' | 'failed'
  sources: SessionTransferIdentity[]
  skipped: (SessionTransferIdentity & { reason: string })[]
  steps: string[]
  failedStep?: string
  failure?: string
  briefSent: boolean
  /** Every change already made, in order; on a failure, what stays changed. */
  applied?: string[]
  acknowledgement?: string
  archived: SessionTransferIdentity[]
  archiveOutcome?: SessionArchiveOutcome['status']
  /** Present for a move to another computer (`--host`); older runtimes never send it. */
  host?: SessionTransferHost
  /** Sources on session hosts, each settled at its own host; older runtimes never send it. */
  hostSources?: SessionTransferHostSourceReceipt[]
  /** The durable transfer id: continuing it settles unresolved sources without a new brief. */
  transfer?: string
}
