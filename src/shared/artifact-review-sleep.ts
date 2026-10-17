/**
 * A session that publishes a review page waits live for `reviewWaitLiveMinutes` after its turn,
 * then sleeps until a decision on the page wakes the same conversation (OAOS-12). The block lives
 * beside the share record's `sourceReview` in `artifact-shares.json` on the publishing computer.
 */

export const ARTIFACT_REVIEW_SLEEP_STATES = [
  'waiting',
  'asleep',
  'waking',
  'awake',
  'moved',
  'deleted',
  'stalled'
] as const
export type ArtifactReviewSleepState = (typeof ARTIFACT_REVIEW_SLEEP_STATES)[number]

export const DEFAULT_REVIEW_WAIT_LIVE_MINUTES = 60
export const MIN_REVIEW_WAIT_LIVE_MINUTES = 1
export const MAX_REVIEW_WAIT_LIVE_MINUTES = 24 * 60

export type ArtifactReviewSleepWorkspace = {
  kind: 'git' | 'folder'
  path: string
  branch?: string
  /** `omni session launch` created this git worktree for this session; only then may Reject delete it. */
  createdForSession?: boolean
  /** The workspace id at publish; a Reject never removes another one the binding moved to. */
  worktreeId?: string
  /** The branch created with the worktree (no branch of that name existed); only it may go. */
  createdBranch?: string
}

export type ArtifactReviewSleep = {
  state: ArtifactReviewSleepState
  /** The page revision the wait is for; a new revision re-arms the wait. */
  revision: number
  armedAt: number
  provider: 'claude' | 'codex'
  /** The provider account home that holds the transcript; resume never switches it. */
  accountHome?: string
  transcriptPath?: string
  model?: string
  effort?: string
  cwd?: string
  workspace?: ArtifactReviewSleepWorkspace
  sleptAt?: number
  /** When the current state was entered. */
  at: number
  /** Plain words: why it is stalled, or what a held wake waits for. */
  reason?: string
  /** A Reject's delete was sent for this decision; once `began` (a tab closed) a pass only finishes it. */
  purge?: { decisionId: string; at: number; began?: true }
  /** A held wake retries after this time (account capacity). */
  retryAfter?: number
  /** Phase 2: the copy on OmniOS another computer may wake it from, or why there is none. */
  wakeCopy?: ArtifactReviewWakeCopy
  /** Phase 2: the computer that woke it instead (state `moved`). */
  movedTo?: { host: string }
  /** It ran here again after it slept (a person opened it): never copied for another computer. */
  reopened?: true
}

/** Why a sleeping session can only wake on its own computer; OmniOS shows these words. */
export const WAKE_COPY_REFUSALS = [
  'outside Work',
  'uncommitted changes',
  'unpushed changes',
  'too large',
  'not available yet',
  'could not verify'
] as const
export type WakeCopyRefusal = (typeof WAKE_COPY_REFUSALS)[number]

export type ArtifactReviewWakeCopy = {
  revision: number
  at: number
  /** Uploaded and complete on OmniOS. */
  sha256?: string
  /** An upload began; a ready copy may exist even without `sha256` (a lost reply). */
  pending?: true
  refused?: WakeCopyRefusal
}

/** A copy of this wait's revision may be on OmniOS, so another computer may take it. */
export function wakeCopyMayExist(sleep: ArtifactReviewSleep): boolean {
  const copy = sleep.wakeCopy
  return copy?.revision === sleep.revision && (Boolean(copy.sha256) || copy.pending === true)
}

function validWakeCopy(value: unknown): boolean {
  if (value === undefined) {
    return true
  }
  const copy = value as ArtifactReviewWakeCopy | null
  return (
    !!copy &&
    typeof copy === 'object' &&
    Number.isSafeInteger(copy.revision) &&
    Number.isSafeInteger(copy.at) &&
    (copy.sha256 === undefined || /^[0-9a-f]{64}$/.test(copy.sha256)) &&
    (copy.pending === undefined || copy.pending === true) &&
    (copy.refused === undefined || (WAKE_COPY_REFUSALS as readonly string[]).includes(copy.refused))
  )
}

/** A pane the hibernation timer sleeps after the review wait, with the flags its wake needs. */
export type ReviewSleepTarget = {
  worktreeId: string
  paneKey: string
  idleMs: number
  launchOptions?: { model?: string; effort?: string }
}

export type ArtifactSessionSleepNotice =
  | { state: 'armed'; liveMinutes: number }
  | { state: 'kept' }
  | { state: 'unavailable'; reason: string }

const PROVIDERS = new Set(['claude', 'codex'])
const STATES: ReadonlySet<string> = new Set(ARTIFACT_REVIEW_SLEEP_STATES)

function optionalText(value: unknown, max = 4096): boolean {
  return (
    value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= max)
  )
}

function optionalTime(value: unknown): boolean {
  return (
    value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
  )
}

function validWorkspace(value: unknown): boolean {
  if (value === undefined) {
    return true
  }
  const workspace = value as ArtifactReviewSleepWorkspace | null
  return (
    !!workspace &&
    typeof workspace === 'object' &&
    (workspace.kind === 'git' || workspace.kind === 'folder') &&
    typeof workspace.path === 'string' &&
    workspace.path.length > 0 &&
    workspace.path.length <= 4096 &&
    optionalText(workspace.branch, 1024) &&
    (workspace.createdForSession === undefined ||
      typeof workspace.createdForSession === 'boolean') &&
    optionalText(workspace.worktreeId) &&
    optionalText(workspace.createdBranch, 1024)
  )
}

export function validArtifactReviewSleep(value: unknown): value is ArtifactReviewSleep {
  if (!value || typeof value !== 'object') {
    return false
  }
  const sleep = value as ArtifactReviewSleep
  return (
    STATES.has(sleep.state) &&
    Number.isSafeInteger(sleep.revision) &&
    sleep.revision > 0 &&
    optionalTime(sleep.armedAt) &&
    sleep.armedAt !== undefined &&
    PROVIDERS.has(sleep.provider) &&
    optionalText(sleep.accountHome) &&
    optionalText(sleep.transcriptPath) &&
    optionalText(sleep.model, 128) &&
    optionalText(sleep.effort, 64) &&
    optionalText(sleep.cwd) &&
    validWorkspace(sleep.workspace) &&
    optionalTime(sleep.sleptAt) &&
    optionalTime(sleep.at) &&
    sleep.at !== undefined &&
    optionalText(sleep.reason, 500) &&
    (sleep.purge === undefined ||
      (typeof sleep.purge === 'object' &&
        sleep.purge !== null &&
        typeof sleep.purge.decisionId === 'string' &&
        Number.isSafeInteger(sleep.purge.at) &&
        (sleep.purge.began === undefined || sleep.purge.began === true))) &&
    optionalTime(sleep.retryAfter) &&
    validWakeCopy(sleep.wakeCopy) &&
    (sleep.reopened === undefined || sleep.reopened === true) &&
    (sleep.movedTo === undefined ||
      (typeof sleep.movedTo === 'object' &&
        sleep.movedTo !== null &&
        optionalText(sleep.movedTo.host, 200)))
  )
}

export function getEffectiveReviewWaitLiveMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_REVIEW_WAIT_LIVE_MINUTES
  }
  return Math.min(
    MAX_REVIEW_WAIT_LIVE_MINUTES,
    Math.max(MIN_REVIEW_WAIT_LIVE_MINUTES, Math.round(value))
  )
}

/**
 * The one line `omni artifacts share|update --review` adds for the publishing agent; `collect`
 * (a review or study) waits for the answers to come in instead of a decision.
 */
export function artifactSessionSleepLine(
  notice: ArtifactSessionSleepNotice | undefined,
  collect = false
): string | null {
  if (!notice) {
    return null
  }
  if (notice.state === 'armed') {
    const wait =
      notice.liveMinutes % 60 === 0
        ? `${notice.liveMinutes / 60} hour${notice.liveMinutes === 60 ? '' : 's'}`
        : `${notice.liveMinutes} minutes`
    return collect
      ? `This session waits for the responses for ${wait} after this turn ends, then goes to sleep. The responses coming in wake it; end your turn after telling the people asked the link. Pass --keep-session to stay running.`
      : `This session waits for a decision for ${wait} after this turn ends, then goes to sleep. A decision on the page wakes it; end your turn after telling the person the link. Pass --keep-session to stay running.`
  }
  if (notice.state === 'kept') {
    return collect
      ? 'This session keeps running (--keep-session); the responses are queued to it once they are in.'
      : 'This session keeps running (--keep-session); a decision on the page is queued to it.'
  }
  return `This session will not sleep for the ${collect ? 'responses' : 'decision'}: ${notice.reason}`
}
