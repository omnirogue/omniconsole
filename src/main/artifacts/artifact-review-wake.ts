/**
 * A decision on a review page reaches a session that went to sleep waiting for it (OAOS-12): the
 * same conversation is resumed on this computer, under the account its transcript lives in, with
 * the model and effort it ran with, and the existing delivery then queues the decision message.
 * Live sessions are left to that delivery as before; only a session the review wait put to sleep
 * is resumed; a conversation that cannot be verified is never started a second time; an account
 * without capacity holds the wake; with no window the wake waits for one (PLAN.md section 5).
 */

import { wakeCopyMayExist, type ArtifactReviewSleep } from '../../shared/artifact-review-sleep'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionManageEntry } from '../../shared/session-manage-types'
import { formatSessionReference, rowsForSessionReference } from '../../shared/session-reference'
import type { SessionResumeResult } from '../../shared/session-resume-types'
import type { ArtifactSourceReview } from './artifact-source-review'
import type { SourceReviewEntry } from './artifact-source-review-watch'

export type ReviewCapacity = { ok: true } | { ok: false; reason: string; retryAfter?: number }

export type ReviewWakeDeps = {
  readRows(): Promise<SessionManageSidebarRow[]>
  observe(row: SessionManageSidebarRow): Promise<SessionManageEntry>
  /** Why the wake must wait (no window), or null when it may resume now. */
  wakeBlocked(): string | null
  capacity(sleep: ArtifactReviewSleep): Promise<ReviewCapacity>
  resume(ref: string, sleep: ArtifactReviewSleep): Promise<SessionResumeResult>
  /** The window restarts a parked row from its own checkpoint (`session restart`'s relay). */
  restartParked(row: SessionManageSidebarRow): Promise<{ summary: string }>
  /** This runtime holds any terminal record for the pane (none after a restart for a slept one). */
  paneHasTerminal(paneKey: string): boolean
  /** A resume failure that already started a terminal: never retried automatically. */
  startedTerminal(error: unknown): boolean
  /** The ledger entry this desktop holds for a pane, for the signed-in account. */
  ledgerFor(paneKey: string): { ledgerId: string; nativeSessionId?: string | null } | null
  saveSleep(entry: SourceReviewEntry, sleep: ArtifactReviewSleep): boolean
  rebind(
    entry: SourceReviewEntry,
    next: Pick<ArtifactSourceReview, 'ledgerId' | 'paneKey' | 'worktreeId'>
  ): ArtifactSourceReview | null
  audit(entry: SourceReviewEntry, summary: string): void
  /** Phase 2: why another computer's claim keeps this one from waking it, or null. */
  wakeClaimElsewhere(entry: SourceReviewEntry, sleep: ArtifactReviewSleep): Promise<string | null>
  /**
   * Phase 2: takes its copy off OmniOS before it runs here; `claimed` when another computer took
   * it first. Called only while a copy may be up.
   */
  withdrawWakeCopy(entry: SourceReviewEntry): Promise<'ok' | 'claimed' | 'failed'>
  now(): number
}

export type ReviewWakeOutcome =
  | { kind: 'deliver'; entry: SourceReviewEntry; woke: boolean }
  | { kind: 'hold'; reason: string }

/** Only waits the review timer put to sleep are resumed; `waiting` ones are live or were ended. */
const RESUMABLE = new Set(['asleep', 'waking', 'stalled'])
const WATCHED = new Set(['waiting', ...RESUMABLE])

/** A wake this recent may still be starting; never start a second copy over it. */
export const REVIEW_WAKE_SETTLE_MS = 3 * 60_000
/** A resume refused before anything started is tried again after this. */
export const REVIEW_WAKE_RETRY_MS = 5 * 60_000

function hold(reason: string): ReviewWakeOutcome {
  return { kind: 'hold', reason }
}

/** Move the binding to the live pane that now holds the conversation. */
function rebindTo(
  deps: ReviewWakeDeps,
  entry: SourceReviewEntry,
  row: SessionManageSidebarRow
): SourceReviewEntry | null {
  const ledger = row.paneKey ? deps.ledgerFor(row.paneKey) : null
  if (!row.paneKey || !ledger || ledger.nativeSessionId !== entry.sourceReview.nativeSessionId) {
    return null
  }
  const sourceReview = deps.rebind(entry, {
    ledgerId: ledger.ledgerId,
    paneKey: row.paneKey,
    worktreeId: row.worktreeId
  })
  return sourceReview ? { ...entry, sourceReview } : null
}

function withState(
  sleep: ArtifactReviewSleep,
  state: ArtifactReviewSleep['state'],
  at: number,
  extra: Partial<ArtifactReviewSleep> = {}
): ArtifactReviewSleep {
  const { reason: _reason, retryAfter: _retryAfter, ...rest } = sleep
  return { ...rest, state, at, ...extra }
}

type Holder =
  | { row: SessionManageSidebarRow; own: boolean }
  | { blocked: string }
  | { parked: SessionManageSidebarRow }
  | null

/**
 * Where the conversation runs: a live pane gets the decision (delivering starts nothing). Only
 * when none is live does an unverifiable holder block a resume; a parked own pane (no terminal
 * record at all) may be restarted by the window, which re-checks its own checkpoint and the daemon.
 */
async function liveHolder(deps: ReviewWakeDeps, entry: SourceReviewEntry): Promise<Holder> {
  const rows = (await deps.readRows()).filter((row) => !row.folded && row.paneKey !== null)
  const own = rows.find(
    (row) =>
      row.paneKey === entry.sourceReview.paneKey && row.worktreeId === entry.sourceReview.worktreeId
  )
  // Why the own pane first, whatever its state: before this wait existed it got the decision.
  const ownVerdict = own ? (await deps.observe(own)).verdict : null
  if (own && ownVerdict === 'live') {
    return { row: own, own: true }
  }
  const parked =
    own && ownVerdict === 'unverifiable' && own.resumable && !deps.paneHasTerminal(own.paneKey!)
      ? own
      : null
  let blocked: string | null =
    own && ownVerdict === 'unverifiable' && !parked
      ? `“${own.title}” cannot be verified, so it is not woken a second time`
      : null
  const holders = rowsForSessionReference(
    { sessionId: entry.sourceReview.nativeSessionId, hostId: 'local' },
    rows.filter((row) => row !== own)
  )
  for (const row of holders) {
    const observed = await deps.observe(row)
    if (observed.verdict === 'live' && observed.state !== 'unknown') {
      return { row, own: false }
    }
    if (observed.verdict !== 'exited') {
      // Loss of contact is never evidence of an exit; a second copy is never started.
      blocked ??= `“${observed.title}” cannot be verified, so it is not woken a second time`
    }
  }
  return blocked ? { blocked } : parked ? { parked } : null
}

/**
 * Finds where the conversation runs now. A live holder (its own pane, or a pane a person or an
 * earlier pass resumed it in) gets the decision; otherwise a slept conversation is resumed once.
 * `cause` names what woke it in the audit: a decision, or a review's answers coming in.
 */
export async function prepareReviewWake(
  deps: ReviewWakeDeps,
  entry: SourceReviewEntry,
  sleep: ArtifactReviewSleep | undefined,
  cause: 'decision' | 'responses' = 'decision'
): Promise<ReviewWakeOutcome> {
  if (sleep?.state === 'deleted' && sleep.revision === entry.sourceReview.revision) {
    // Reject then Approve: the session is gone; the page and Work tab say so.
    return hold('the session was deleted when this page was rejected')
  }
  if (sleep?.state === 'moved' && sleep.revision === entry.sourceReview.revision) {
    return hold(sleep.reason ?? 'it moved to another computer')
  }
  // Why before anything runs here: a copy another computer woke from is that computer's now.
  const elsewhere =
    sleep && sleep.revision === entry.sourceReview.revision && RESUMABLE.has(sleep.state)
      ? await deps.wakeClaimElsewhere(entry, sleep)
      : null
  if (elsewhere) {
    return hold(elsewhere)
  }
  if (!sleep || sleep.revision !== entry.sourceReview.revision || !WATCHED.has(sleep.state)) {
    return { kind: 'deliver', entry, woke: false }
  }
  const live = await liveHolder(deps, entry)
  if (live && 'blocked' in live) {
    return hold(live.blocked)
  }
  const parked = live && 'parked' in live ? live.parked : null
  if (live && 'row' in live) {
    // Why only `waking`: a pane a person opened again was not woken by this decision.
    const woke = sleep.state === 'waking'
    if (live.own) {
      return { kind: 'deliver', entry, woke }
    }
    const rebound = rebindTo(deps, entry, live.row)
    return rebound
      ? { kind: 'deliver', entry: rebound, woke }
      : hold('the resumed pane has not reported yet')
  }
  if (!RESUMABLE.has(sleep.state)) {
    // Not running and not slept for this review (ended by hand, or this computer never sleeps it).
    return hold('it is not running and was not put to sleep for this review; open it to continue')
  }
  const now = deps.now()
  if (sleep.state === 'waking' && now - sleep.at < REVIEW_WAKE_SETTLE_MS) {
    return hold('the woken conversation is still starting')
  }
  if (sleep.state === 'stalled' && (sleep.retryAfter === undefined || now < sleep.retryAfter)) {
    return hold(sleep.reason ?? 'its wake stalled')
  }
  const blocked = deps.wakeBlocked()
  if (blocked) {
    return hold(blocked)
  }
  const capacity = await deps.capacity(sleep)
  if (!capacity.ok) {
    deps.saveSleep(
      entry,
      withState(sleep, 'asleep', sleep.at, {
        reason: capacity.reason,
        ...(capacity.retryAfter ? { retryAfter: capacity.retryAfter } : {})
      })
    )
    return hold(capacity.reason)
  }
  if (wakeCopyMayExist(sleep)) {
    // Why before the resume: OmniOS refuses this while a claim is active, so only one runs it.
    const withdrawn = await deps.withdrawWakeCopy(entry)
    if (withdrawn !== 'ok') {
      return hold(
        withdrawn === 'claimed'
          ? 'another computer took it first'
          : 'its copy on OmniOS could not be withdrawn yet'
      )
    }
  }
  const { wakeCopy: _withdrawn, ...unshared } = sleep
  if (!deps.saveSleep(entry, withState(unshared, 'waking', now))) {
    return hold('the share record changed')
  }
  const ref = formatSessionReference({
    agent: sleep.provider,
    sessionId: entry.sourceReview.nativeSessionId,
    hostId: 'local'
  })
  let result: { summary: string }
  try {
    result = parked ? await deps.restartParked(parked) : await deps.resume(ref, sleep)
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 480)
    // Why no automatic retry once a terminal started: a second launch could run it twice.
    deps.saveSleep(
      entry,
      withState(unshared, 'stalled', deps.now(), {
        reason,
        ...(deps.startedTerminal(error) ? {} : { retryAfter: deps.now() + REVIEW_WAKE_RETRY_MS })
      })
    )
    deps.audit(entry, `The ${cause} could not wake ${ref}: ${reason}`)
    return hold(reason)
  }
  deps.audit(entry, `Woke ${ref} for the ${cause} on page ${entry.slug}: ${result.summary}`)
  const woken = await liveHolder(deps, entry)
  if (woken && 'row' in woken) {
    const rebound = woken.own ? entry : rebindTo(deps, entry, woken.row)
    if (rebound) {
      return { kind: 'deliver', entry: rebound, woke: true }
    }
  }
  // Still `waking`: the next pass finds the new pane once its agent reports the conversation.
  return hold('the woken conversation has not reported its pane yet')
}

/** After the decision was queued: the session is awake and no longer waits on this page. */
export function markReviewDelivered(
  deps: Pick<ReviewWakeDeps, 'saveSleep' | 'now'>,
  entry: SourceReviewEntry,
  sleep: ArtifactReviewSleep | undefined
): void {
  if (sleep && sleep.revision === entry.sourceReview.revision && sleep.state !== 'awake') {
    deps.saveSleep(entry, withState(sleep, 'awake', deps.now()))
  }
}
