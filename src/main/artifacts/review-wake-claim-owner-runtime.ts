/**
 * The owner computer's claim check and copy withdrawal on this runtime and its window, plus what
 * "the conversation runs here" means for a wait: a live pane holding it, never a guess.
 */

import { rowsForSessionReference } from '../../shared/session-reference'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionManageEntry } from '../../shared/session-manage-types'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { yieldSessionHostConversationToClaim } from '../session-host/session-host-claimed-away'
import { activeRuntimeSessionHost } from '../session-host/session-host-runtime'
import type { ReviewWakeDeps } from './artifact-review-wake'
import type { SourceReviewEntry } from './artifact-source-review-watch'
import { wakeClaimElsewhere } from './review-wake-claim-owner'
import { readWakeClaim, withdrawWakeCopy, type WakeCopyApi } from './review-wake-copy-api'
import type { ArtifactReviewSleep } from '../../shared/artifact-review-sleep'
import { relocatedAwayIn } from '../session-host-owner/session-host-relocated-journal'

type RowReader = {
  readRows(): Promise<SessionManageSidebarRow[]>
  observe(row: SessionManageSidebarRow): Promise<SessionManageEntry>
}

/**
 * True when a pane holding the conversation is live; false when every holder exited or is a pane
 * the window confirms parked by sleep; null when that cannot be told (loss of contact is never exit).
 */
export function conversationRunning(
  input: RowReader & { paneParked(paneKey: string, sleptAt: number | undefined): Promise<boolean> }
): (entry: SourceReviewEntry, sleptAt: number | undefined) => Promise<boolean | null> {
  return async (entry, sleptAt) => {
    const rows = await input.readRows().catch(() => null)
    if (!rows) {
      return null
    }
    const panes = rows.filter((row) => row.paneKey !== null)
    const own = panes.filter(
      (row) =>
        row.paneKey === entry.sourceReview.paneKey &&
        row.worktreeId === entry.sourceReview.worktreeId
    )
    const holders = rowsForSessionReference(
      { sessionId: entry.sourceReview.nativeSessionId, hostId: 'local' },
      panes
    )
    let unknown = false
    for (const row of new Set([...own, ...holders])) {
      const verdict = (await input.observe(row)).verdict
      if (verdict === 'live') {
        return true
      }
      if (verdict === 'unverifiable' && !(await input.paneParked(row.paneKey!, sleptAt))) {
        unknown = true
      }
    }
    return unknown ? null : false
  }
}

/** Long enough for a restarted runtime to adopt the terminals its daemon kept running. */
const ADOPTION_GRACE_MS = 2 * 60_000
/** An exit report the agent sends while it is put to sleep can land just after; it is no resume. */
const LATE_EXIT_REPORT_MS = 60_000

/**
 * A pane hibernation parked: no terminal here, and the window confirms its checkpoint and that the
 * daemon's PTY is gone. Without a window (nothing there restarts a parked pane): no terminal after
 * the runtime had time to adopt the daemon's, and no agent report from the pane since it slept.
 */
export function runtimePaneParked(
  runtime: Pick<
    OrcaRuntimeService,
    'getTerminalHandleForPaneKey' | 'requestSessionFolders' | 'getLastAgentHookRowForPane'
  >,
  windowAttached: () => boolean,
  uptimeMs: () => number = () => process.uptime() * 1000
): (paneKey: string, sleptAt: number | undefined) => Promise<boolean> {
  return async (paneKey, sleptAt) => {
    if (runtime.getTerminalHandleForPaneKey(paneKey) !== null) {
      return false
    }
    if (!windowAttached()) {
      const reported = runtime.getLastAgentHookRowForPane(paneKey)?.receivedAt
      return (
        uptimeMs() >= ADOPTION_GRACE_MS &&
        sleptAt !== undefined &&
        !(reported !== undefined && reported > sleptAt + LATE_EXIT_REPORT_MS)
      )
    }
    return runtime
      .requestSessionFolders({ kind: 'paneParkedBySleep', paneKey })
      .then((answer) => answer === true)
      .catch(() => false)
  }
}

/** The wake path's claim check and copy withdrawal, on the runtime and the window. */
export function runtimeWakeClaimDeps(
  input: RowReader & {
    runtime: Pick<
      OrcaRuntimeService,
      'requestSessionFolders' | 'getTerminalHandleForPaneKey' | 'getLastAgentHookRowForPane'
    >
    api: WakeCopyApi
    archiveRow(row: SessionManageSidebarRow, reason: string): Promise<void>
    saveSleep: ReviewWakeDeps['saveSleep']
    windowAttached(): boolean
    now(): number
  }
): Pick<ReviewWakeDeps, 'wakeClaimElsewhere' | 'withdrawWakeCopy'> {
  const parked = runtimePaneParked(input.runtime, input.windowAttached)
  // Why: once given up in the registry and its checkpoint dropped, nothing here can start it, so
  // a pane with no terminal is not running it (the archive may still be retried); a pane with one
  // may be starting, and is never taken for parked.
  const noTerminal = async (paneKey: string) =>
    input.runtime.getTerminalHandleForPaneKey(paneKey) === null
  const running = (entry: SourceReviewEntry, sleep: ArtifactReviewSleep) => {
    const journal = activeRuntimeSessionHost()?.current()?.store.snapshot()
    const yielded =
      relocatedAwayIn(journal, {
        agent: sleep.provider,
        sessionId: entry.sourceReview.nativeSessionId
      }) !== null
    return conversationRunning({
      ...input,
      paneParked: yielded ? noTerminal : parked
    })(entry, sleep.sleptAt)
  }
  const ownRow = async (entry: SourceReviewEntry) =>
    (await input.readRows()).find(
      (row) =>
        row.paneKey === entry.sourceReview.paneKey &&
        row.worktreeId === entry.sourceReview.worktreeId
    )
  return {
    wakeClaimElsewhere: (entry, sleep) =>
      wakeClaimElsewhere(
        {
          readClaim: (slug, revision) => readWakeClaim(input.api, slug, revision),
          hostId: () => activeRuntimeSessionHost()?.current()?.identity.hostId ?? null,
          windowAttached: input.windowAttached,
          yieldConversation: async (slept, sessionId, claim) => {
            const store = activeRuntimeSessionHost()?.current()?.store
            return store
              ? yieldSessionHostConversationToClaim(store, {
                  provider: { agent: slept.provider, sessionId },
                  toHostId: claim.hostId,
                  claimId: `${entry.slug}:${claim.decisionId}`,
                  digest: slept.wakeCopy?.sha256 ?? ''
                })
              : { status: 'refused', reason: 'this computer has no session registry open' }
          },
          running,
          forgetSleptPane: (paneKey) =>
            input.runtime
              .requestSessionFolders({ kind: 'forgetSleptPane', paneKey })
              .then((answer) => answer === true)
              .catch(() => false),
          archiveOwnRow: async (target, reason) => {
            const row = await ownRow(target)
            if (row && !row.archived) {
              await input.archiveRow(row, reason)
            }
          },
          saveSleep: input.saveSleep,
          now: input.now
        },
        entry,
        sleep
      ),
    withdrawWakeCopy: (entry) => withdrawWakeCopy(input.api, entry.slug)
  }
}
