/**
 * Reject on a review page deletes the session that asked, for good and at once (Sal's decisions
 * 1, 2 and 4; PLAN.md section 6): its rows and tabs (no Recently closed entry, on the deleted
 * list so resume refuses it), its queued prompts, decisions and outcome chain, every copy of its
 * transcript, and its own worktree and branch. Never deleted, even on Reject: a session that is
 * busy (it is told to stop and goes when idle), one that still waits on or acts on another page,
 * a protected one, one this computer cannot verify, or any with no window to read its rows from.
 * Deletion happens only on this computer; a delete that began is finished on a later pass.
 */

import type { ArtifactReviewDecision } from '../../shared/artifact-review'
import type { ArtifactReviewSleep } from '../../shared/artifact-review-sleep'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionManageEntry } from '../../shared/session-manage-types'
import { rowsForSessionReference } from '../../shared/session-reference'
import type { SourceReviewEntry } from './artifact-source-review-watch'
import type { TranscriptPurge } from './artifact-review-transcript-purge'
import type { WorkspacePurge } from './artifact-review-workspace-purge'
import { REVIEW_WAKE_SETTLE_MS } from './artifact-review-wake'

export type ReviewRejectDeps = {
  /** The window's own rows, folded panes included; throws when no window can answer. */
  readWindowRows(): Promise<SessionManageSidebarRow[]>
  observe(row: SessionManageSidebarRow): Promise<SessionManageEntry>
  windowAttached(): boolean
  /**
   * The pane is one hibernation slept and nothing runs there: the runtime has no terminal for it,
   * and the window finds its own sleep checkpoint and the daemon answering its PTY is gone.
   */
  paneParked(row: SessionManageSidebarRow): Promise<boolean>
  /** The window lists the conversation as deleted (a sent delete applied, or a person deleted it). */
  conversationDeleted(sessionId: string): Promise<boolean>
  /** Why automatic cleanup must keep this pane (started-today lifted), or null. */
  protection(target: { worktreeId: string; paneKey: string }): Promise<string | null>
  /** Other pages this conversation still waits on or acts on (pending or approved). */
  otherOpenReviews(entry: SourceReviewEntry): Promise<string[]>
  deleteRow(
    row: SessionManageSidebarRow,
    reason: string,
    evidence: string
  ): Promise<'closed' | 'declined' | 'unverified'>
  purgeStores(rows: readonly SessionManageSidebarRow[], sessionId: string): Promise<string[]>
  purgeTranscripts(
    provider: 'claude' | 'codex',
    sessionId: string,
    transcriptPath?: string
  ): Promise<TranscriptPurge>
  purgeWorkspace(input: {
    worktreeId: string
    workspace: ArtifactReviewSleep['workspace']
    sharedWithAnotherSession: boolean
  }): Promise<WorkspacePurge>
  saveSleep(entry: SourceReviewEntry, sleep: ArtifactReviewSleep): boolean
  audit(entry: SourceReviewEntry, decision: ArtifactReviewDecision, summary: string): Promise<void>
  now(): number
}

/** `deliver`: let the normal delivery tell a live session to stop; `done`: nothing to send. */
export type ReviewRejectOutcome = 'deliver' | 'done'

const KEPT = 'Rejected; '

/** A kept session drops the purge marker; any other hold keeps it so the delete can finish. */
function note(
  deps: Pick<ReviewRejectDeps, 'saveSleep' | 'now'>,
  entry: SourceReviewEntry,
  sleep: ArtifactReviewSleep,
  state: ArtifactReviewSleep['state'],
  reason: string
): void {
  if (sleep.state !== state || sleep.reason !== reason) {
    const { retryAfter: _retryAfter, purge, ...rest } = sleep
    const marker = purge && !reason.startsWith(KEPT) ? { purge } : {}
    deps.saveSleep(entry, { ...rest, ...marker, state, reason, at: deps.now() })
  }
}

type Keep = { reason: string; outcome: ReviewRejectOutcome }

/** Every holder must be idle, exited or parked; busy is told to stop, unknown is never guessed. */
async function keepReason(
  deps: ReviewRejectDeps,
  targets: readonly SessionManageSidebarRow[]
): Promise<Keep | null> {
  for (const row of targets) {
    const observed = await deps.observe(row)
    // Why parked is not unverifiable: a slept pane has no terminal record after a restart while
    // the window still holds its checkpoint; closing its tab stops nothing.
    const parked =
      observed.verdict === 'unverifiable' && row.resumable && (await deps.paneParked(row))
    if (!parked && (observed.verdict === 'unverifiable' || observed.state === 'unknown')) {
      // Loss of contact is never evidence of an exit, so nothing is deleted on a guess.
      return {
        reason: `Rejected · deleted once “${observed.title}” can be verified`,
        outcome: 'done'
      }
    }
    if (observed.verdict === 'live' && observed.state !== 'idle') {
      return { reason: 'Rejected · told to stop; deleted when it is idle', outcome: 'deliver' }
    }
  }
  for (const row of targets) {
    const protection = row.paneKey
      ? await deps.protection({ worktreeId: row.worktreeId, paneKey: row.paneKey })
      : 'protection-unknown'
    if (protection) {
      return { reason: `${KEPT}kept because it is protected (${protection})`, outcome: 'deliver' }
    }
  }
  return null
}

function summaryOf(
  reason: string,
  targets: number,
  stores: readonly string[],
  transcripts: TranscriptPurge,
  workspace: WorkspacePurge
): string {
  return [
    `${reason}: deleted the session (${targets} tab${targets === 1 ? '' : 's'}, not in Recently closed).`,
    stores.length ? `Cleared ${stores.join(', ')}.` : '',
    `Transcript files removed: ${transcripts.removed.length}${transcripts.failed.length ? `; could not remove: ${transcripts.failed.join(', ')}` : ''}.`,
    workspace.removed.length ? `Removed ${workspace.removed.join(', ')}.` : '',
    workspace.kept.length ? `Kept ${workspace.kept.join('; ')}.` : '',
    'The page, its revisions, the decision and this line are the record.'
  ]
    .filter(Boolean)
    .join(' ')
}

export async function handleReviewReject(
  deps: ReviewRejectDeps,
  entry: SourceReviewEntry,
  sleep: ArtifactReviewSleep | undefined,
  decision: ArtifactReviewDecision
): Promise<ReviewRejectOutcome> {
  if (!sleep || sleep.revision !== entry.sourceReview.revision) {
    return 'deliver'
  }
  // Why moved too: the conversation is another computer's now; its history here is not the session.
  if (sleep.state === 'deleted' || sleep.state === 'moved') {
    return 'done'
  }
  // A kept session gets the stop message once; it is not deleted on a later pass.
  if (sleep.state === 'stalled' && sleep.reason?.startsWith(KEPT)) {
    return 'deliver'
  }
  // Why two steps: a marker alone means a delete may have been sent; `began` means a tab closed,
  // so the checks were passed and only finishing remains.
  const marked = sleep.purge?.decisionId === String(decision.id)
  let began = marked && sleep.purge?.began === true
  const now = deps.now()
  if (!began && sleep.state === 'waking' && now - sleep.at < REVIEW_WAKE_SETTLE_MS) {
    return 'done'
  }
  if (!began) {
    const others = await deps.otherOpenReviews(entry)
    if (others.length > 0) {
      note(
        deps,
        entry,
        sleep,
        'stalled',
        `${KEPT}kept because it still waits on page ${others.join(', ')}`
      )
      return 'deliver'
    }
  }
  const rows = deps.windowAttached() ? await deps.readWindowRows().catch(() => null) : null
  if (!rows) {
    note(deps, entry, sleep, sleep.state, 'Rejected · deleted when the OmniConsole window opens')
    return 'done'
  }
  const sessionId = entry.sourceReview.nativeSessionId
  const panes = rows.filter((row) => row.paneKey !== null)
  // Why folded rows too: a second pane of the same conversation must be checked and deleted.
  const holders = rowsForSessionReference({ sessionId, hostId: 'local' }, panes)
  const own = panes.find(
    (row) =>
      row.paneKey === entry.sourceReview.paneKey &&
      row.worktreeId === entry.sourceReview.worktreeId &&
      (row.providerSessionId === undefined ||
        row.providerSessionId === null ||
        row.providerSessionId === sessionId)
  )
  const targets = own && !holders.includes(own) ? [...holders, own] : holders
  // Why the deleted list: a sent delete the window refused leaves nothing listed once a person
  // closes the tab, but only an applied one puts the conversation on it.
  const resuming =
    began || (marked && targets.length === 0 && (await deps.conversationDeleted(sessionId)))
  if (!resuming && targets.length === 0) {
    // Why hold: a window still loading lists nothing, and an unlisted pane's protection is unknown.
    note(deps, entry, sleep, sleep.state, 'Rejected · deleted once its session is listed')
    return 'done'
  }
  if (!resuming) {
    const keep = await keepReason(deps, targets)
    if (keep) {
      note(deps, entry, sleep, keep.reason.startsWith(KEPT) ? 'stalled' : sleep.state, keep.reason)
      return keep.outcome
    }
    const { retryAfter: _retryAfter, ...rest } = sleep
    if (!deps.saveSleep(entry, { ...rest, purge: { decisionId: String(decision.id), at: now } })) {
      return 'done'
    }
  }
  const reason = `Rejected on review page ${entry.slug} revision ${decision.revision} by ${decision.by.name || decision.by.email}`
  for (const row of targets) {
    let closed: 'closed' | 'declined' | 'unverified' | 'failed'
    try {
      closed = await deps.deleteRow(row, reason, `artifact-review:${entry.slug}:${decision.id}`)
    } catch {
      // A relay that failed (no answer, window closing) is tried again; the marker stays.
      closed = 'failed'
    }
    if (closed === 'declined' && !began) {
      note(
        deps,
        entry,
        sleep,
        'stalled',
        `${KEPT}its tab “${row.title}” did not close, so nothing was deleted`
      )
      return 'done'
    }
    // Before any tab closed, a refusal (it turned busy) or no answer leaves only the marker: the
    // next pass checks everything again, and finishes only if nothing is listed any more.
    if (closed === 'declined' || closed === 'failed') {
      return 'done'
    }
    if (!began) {
      began = true
      const { retryAfter: _retryAfter, ...rest } = sleep
      deps.saveSleep(entry, {
        ...rest,
        purge: { decisionId: String(decision.id), at: sleep.purge?.at ?? now, began: true }
      })
    }
  }
  const worktreeId = sleep.workspace?.worktreeId ?? ''
  const sharedWithAnotherSession = panes.some(
    (row) => row.worktreeId === worktreeId && !targets.includes(row)
  )
  const stores = await deps.purgeStores(targets, sessionId).catch(() => [] as string[])
  const transcripts = await deps
    .purgeTranscripts(sleep.provider, sessionId, sleep.transcriptPath)
    .catch((error: unknown): TranscriptPurge => ({ removed: [], failed: [String(error)] }))
  const workspace = await deps
    .purgeWorkspace({ worktreeId, workspace: sleep.workspace, sharedWithAnotherSession })
    .catch((error: unknown): WorkspacePurge => ({
      removed: [],
      kept: [`its worktree: ${error instanceof Error ? error.message : String(error)}`]
    }))
  const summary = summaryOf(reason, targets.length, stores, transcripts, workspace)
  await deps.audit(entry, decision, summary)
  const { reason: _reason, retryAfter: _retry, purge: _purge, ...rest } = sleep
  deps.saveSleep(entry, {
    ...rest,
    state: 'deleted',
    at: deps.now(),
    reason: summary.slice(0, 500)
  })
  return 'done'
}

/**
 * A page closed with no decision (withdrawn, no action, or replaced) is not a Reject: a session
 * asleep for it is archived, which can be undone, and its wait ends. A live, protected or
 * unverifiable one only stops waiting; with no window the wait stays until one can answer.
 */
export async function endReviewWaitWithoutDecision(
  deps: Pick<
    ReviewRejectDeps,
    'readWindowRows' | 'observe' | 'windowAttached' | 'protection' | 'otherOpenReviews'
  > & {
    archiveRow(row: SessionManageSidebarRow, reason: string): Promise<void>
    clearSleep(entry: SourceReviewEntry): void
  },
  entry: SourceReviewEntry,
  sleep: ArtifactReviewSleep | undefined
): Promise<void> {
  if (!sleep || sleep.revision !== entry.sourceReview.revision || sleep.state === 'deleted') {
    return
  }
  if (sleep.state === 'asleep' || sleep.state === 'stalled') {
    if (!deps.windowAttached()) {
      return
    }
    const rows = await deps.readWindowRows().catch(() => null)
    if (!rows) {
      return
    }
    const own = rows.find(
      (row) =>
        row.paneKey === entry.sourceReview.paneKey &&
        row.worktreeId === entry.sourceReview.worktreeId
    )
    const settled =
      own &&
      !own.archived &&
      (await deps.otherOpenReviews(entry)).length === 0 &&
      (await deps.observe(own)).verdict === 'exited' &&
      !(await deps.protection({ worktreeId: own.worktreeId, paneKey: own.paneKey! }))
    if (settled) {
      await deps.archiveRow(own, `Its review page ${entry.slug} was closed without a decision`)
    }
  }
  deps.clearSleep(entry)
}
