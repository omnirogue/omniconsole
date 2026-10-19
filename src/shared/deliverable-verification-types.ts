/**
 * What the deliverable check (W22-20) records about one finished turn: the items the person asked
 * for or the agent says it produced, what the execution host found for each, and what happened next.
 * Records hold paths, sizes, times and hashes only — never file contents.
 */

/** Where an item came from, highest priority first. */
export const DELIVERABLE_SOURCES = ['request', 'prep', 'mission', 'claim'] as const
export type DeliverableSource = (typeof DELIVERABLE_SOURCES)[number]

export type DeliverableKind = 'file' | 'directory' | 'artifact' | 'url'

/** What the reply says happened to it; `named` when only the request names it. */
export type DeliverableClaim = 'created' | 'updated' | 'published' | 'named'

/** JEV's evidence vocabulary; `declined` is an item the reply honestly says it did not do. */
export type DeliverableVerdict = 'verified' | 'missing' | 'unverifiable' | 'declined'

export type DeliverableOverall = 'complete' | 'incomplete' | 'unverifiable'

export type DeliverableAction =
  | 'none'
  | 'would-repair'
  | 'repair-sent'
  | `skipped:${string}`
  | 'stopped:no-progress'
  | 'exhausted'

export type DeliverableItem = {
  /** As written: a path (absolute or relative to the workspace) or a link. */
  target: string
  kind: DeliverableKind
  source: DeliverableSource
  claim: DeliverableClaim
  /** The reply's own words declining it, clipped. */
  declined?: string
}

export type DeliverableCheck = DeliverableItem & {
  verdict: DeliverableVerdict
  /** Plain words for a person and for the repair prompt ("no file on this computer"). */
  detail: string
  /** The resolved path the host checked. */
  path?: string
  size?: number
  mtimeMs?: number
  sha256?: string
}

export type DeliverableVerificationRecord = {
  id: string
  paneKey: string
  worktreeId: string
  /** The conversation's prompt-queue row key. */
  conversationKey: string
  agent?: string
  /** `local`, or `ssh:<connection id>` for a workspace on an SSH host. */
  host: string
  turnKey: string
  /** One per person request; repair turns keep their request's id. */
  requestId: string
  requestStartedAt: number | null
  checkedAt: number
  checks: DeliverableCheck[]
  overall: DeliverableOverall
  mode: 'shadow' | 'on'
  action: DeliverableAction
  /** Repair prompts sent for this request so far, this one included. */
  repairsSent: number
  maxRepairs: number
  /** The repair prompt's queue id and marker token, when one was sent. */
  promptId?: string
  token?: string
  /** The person marked a missing item here as not a problem. */
  falseAlarmAt?: number
}

export const DELIVERABLE_VERIFICATION_RPC = {
  list: 'deliverables.list',
  markFalseAlarm: 'deliverables.markFalseAlarm'
} as const

/** The overall reading: any missing item makes it incomplete; declined items do not. */
export function deliverableOverall(checks: readonly DeliverableCheck[]): DeliverableOverall {
  if (checks.some((check) => check.verdict === 'missing')) {
    return 'incomplete'
  }
  return checks.some((check) => check.verdict === 'unverifiable') ? 'unverifiable' : 'complete'
}
