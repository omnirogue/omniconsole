/**
 * What the steward's rules loop reports (Phase 2, WP-S2): what it did and why, what it could not
 * move (Stalled), working sessions that went silent, and the result card of every session it
 * archived as "finished, not verified". Read by the Work card and `omni`; nothing here acts.
 */

export const SESSION_STEWARD_STATUS_RPC = {
  status: 'sessionSteward.status',
  finished: 'sessionSteward.finished'
} as const

export const SESSION_STEWARD_ACTIVITY_KINDS = [
  'yes',
  'nudge',
  'ask',
  'archive',
  /** A blank session deleted the way the sidebar's Delete does: its tab closed, its agent stopped. */
  'close',
  /** A switch in shadow mode: what it would have done, and did not. */
  'would-yes',
  'would-archive',
  /** A hard stop, a delivery rule or a limit kept it from acting. */
  'refused',
  /** Finished, but kept (with its result card saved) for a session waiting on it. */
  'kept',
  'stalled',
  'silent',
  /** The pile-up detector started, or could not start, a cleanup session. */
  'cleanup'
] as const
export type SessionStewardActivityKind = (typeof SESSION_STEWARD_ACTIVITY_KINDS)[number]

export type SessionStewardActivity = {
  at: number
  kind: SessionStewardActivityKind
  paneKey?: string
  title?: string
  /** One plain sentence. */
  summary: string
}

/** A session the steward tried and could not move, with why. Cleared by its next turn. */
export type SessionStewardStalled = { paneKey: string; title: string; at: number; reason: string }

/** Working with no terminal output for a while: suggested for a restart, never restarted. */
export type SessionStewardSilent = {
  paneKey: string
  title: string
  since: number
  minutes: number
}

export type SessionStewardStatus = {
  /** Why the steward is not acting on this computer now; null while it runs. */
  off: string | null
  stalled: SessionStewardStalled[]
  silent: SessionStewardSilent[]
  /** Newest first, the last 24 hours. */
  activity: SessionStewardActivity[]
  /** Steward prompts (Yes, nudges, questions) sent on this computer today; limits are per session. */
  prompts: { today: number }
}

export type StewardResultPullRequest = {
  owner: string
  repo: string
  number: number
  url: string
  title?: string
  state?: string
}

export type StewardResultReceipt = {
  kind: string
  target: string
  receipt: string
  verifiedAt: number
}

/**
 * What a finished session left behind, built without any model before it was archived:
 * `<userData>/session-steward/results/`. Labelled "finished, not verified", never verified.
 */
export type StewardResultCard = {
  /** The session's archive key (its sidebar view key). */
  key: string
  paneKey: string
  title: string
  goal: string | null
  /** The end of its last reply. */
  lastReply: string
  pullRequests: StewardResultPullRequest[]
  changedFiles: string[]
  branch: string | null
  outcomeReceipts: StewardResultReceipt[]
  artifacts: { url: string; kind: string }[]
  /** The session's own summary, when one exists; archiving never waits for it. */
  summary?: string
  /** The finished turn it describes. */
  turnKey?: string
  /** What made it safe to archive ("JEV resolved 0.91 · quiet 7 h"). */
  evidence: string
  builtAt: number
  /** Set on read: when the archive was applied and the change Undo reverses. */
  archivedAt?: number
  opId?: string
}

export type SessionStewardFinishedResult = { cards: StewardResultCard[] }

/** Where the renderer remembers the last time the person looked at Finished sessions. */
export const STEWARD_FINISHED_SEEN_STORAGE_KEY = 'omni.steward-finished-seen.v1'
