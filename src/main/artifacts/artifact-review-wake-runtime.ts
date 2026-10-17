import { resolve } from 'node:path'
import {
  classifyLaunchAccountRow,
  launchFableRule,
  LAUNCH_ACCOUNT_FRESH_MS
} from '../../shared/account-launch-verdict'
import type { ArtifactReviewSleep } from '../../shared/artifact-review-sleep'
import { normalizeLaunchCause } from '../../shared/launch-cause'
import type { AccountCapacityRow } from '../../shared/provider-account-capacity'
import type { SessionManageActor } from '../../shared/session-manage-types'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { ledgerSourceForSession } from '../session-ledger/ledger-lookup'
import { sessionActionsLogFor } from '../session-manage/session-actions-log'
import { toSessionManageEntry } from '../session-manage/session-manage-inventory'
import { observeSession } from '../session-manage/session-manage-observe'
import { resumeConversation } from '../session-manage/session-manage-resume'
import { SessionManagePartialError } from '../session-manage/session-manage-refusal'
import { runtimeResumeDeps } from '../session-manage/session-manage-resume-runtime'
import {
  readSidebarRows,
  runtimeControlDeps
} from '../session-manage/session-manage-runtime-actions'
import { createRuntimeObserveSources } from '../session-manage/session-manage-runtime-sources'
import { rebindArtifactSourceReview, saveArtifactReviewSleep } from './artifact-share-record-sleep'
import type { ArtifactShareScope } from './artifact-share-record-store'
import { reviewWakeRowsWithoutWindow } from './artifact-review-wake-host'
import type { ReviewCapacity, ReviewWakeDeps } from './artifact-review-wake'

// Why the steward actor: an in-process resume no person typed, as the outcome waiter does.
const WAKE_ACTOR: SessionManageActor = { kind: 'steward', feature: 'rules' }
const STALE_READING_GRACE_MS = 5 * 60_000

const homeOf = (row: AccountCapacityRow): string | undefined =>
  row.launchEnv?.[row.provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']

function clock(at: number): string {
  return new Date(at).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  })
}

type Runtime = OrcaRuntimeService

/**
 * The transcript's own account must have room: a resume never switches accounts
 * (docs/reference/agent-launch.md), so a limited account holds the wake until its reset.
 */
export function reviewWakeCapacity(
  runtime: Pick<Runtime, 'getAccountsSnapshot' | 'refreshAccountsForMobileSubscriber'>,
  staleSince: Map<string, number>,
  sleep: ArtifactReviewSleep,
  now = Date.now()
): ReviewCapacity {
  const home = sleep.accountHome
  const rows = home
    ? (runtime.getAccountsSnapshot().rateLimits.accountCapacity?.[sleep.provider] ?? [])
    : []
  const row = rows.find((candidate) => {
    const candidateHome = homeOf(candidate)
    return candidateHome !== undefined && resolve(candidateHome) === resolve(home!)
  })
  if (!row) {
    // No reading names this home (a default login): the account cannot be checked, only used.
    return { ok: true }
  }
  const label = row.email ?? 'its account'
  const verdict = classifyLaunchAccountRow(row, {
    now,
    freshMs: LAUNCH_ACCOUNT_FRESH_MS,
    fable: launchFableRule(sleep.provider, sleep.model)
  })
  if (verdict.state === 'fresh') {
    staleSince.delete(home!)
    return { ok: true }
  }
  if (verdict.state === 'limited') {
    return {
      ok: false,
      reason: `capacity: waiting for ${label}${verdict.until ? ` (resets ~${clock(verdict.until)} ET)` : ''}`,
      ...(verdict.until ? { retryAfter: verdict.until } : {})
    }
  }
  if (verdict.state === 'signed-out') {
    return {
      ok: false,
      reason: `capacity: ${label} is signed out on this computer (${verdict.reason})`
    }
  }
  void runtime.refreshAccountsForMobileSubscriber().catch(() => {})
  const since = staleSince.get(home!) ?? now
  staleSince.set(home!, since)
  // Why a grace and then go: a reading the provider never refreshes must not strand the wake.
  return now - since < STALE_READING_GRACE_MS
    ? { ok: false, reason: `capacity: reading ${label}'s usage (${verdict.reason})` }
    : { ok: true }
}

/** The rows and verdicts a review pass reads: the window's, else the owner's last listing. */
export function runtimeReviewRowReader(
  runtime: Runtime
): Pick<ReviewWakeDeps, 'readRows' | 'observe'> & { windowAttached(): boolean } {
  const sources = createRuntimeObserveSources(runtime)
  const windowAttached = (): boolean => runtime.getStatus().desktopWindowStatus === 'available'
  const headlessRows = () => reviewWakeRowsWithoutWindow()?.() ?? Promise.resolve([])
  return {
    windowAttached,
    readRows: () =>
      windowAttached() ? readSidebarRows(runtime).catch(() => headlessRows()) : headlessRows(),
    observe: async (row) => toSessionManageEntry(await observeSession(row, sources))
  }
}

export function runtimeReviewWakeDeps(input: {
  runtime: Runtime
  userDataPath: string
  profileId: string
  scope: ArtifactShareScope
  account: string
}): Omit<ReviewWakeDeps, 'wakeClaimElsewhere' | 'withdrawWakeCopy'> {
  const { runtime, userDataPath, profileId, scope, account } = input
  const staleSince = new Map<string, number>()
  const { windowAttached, readRows, observe } = runtimeReviewRowReader(runtime)
  return {
    readRows,
    observe,
    capacity: async (sleep) => reviewWakeCapacity(runtime, staleSince, sleep),
    // Why a window: only it can restart a parked row in place from its record, and a resume with
    // none starts a tab the owner's remembered rows never show, so it could be started again.
    wakeBlocked: () =>
      windowAttached() ? null : 'it wakes when the OmniConsole window opens on this computer',
    resume: (ref, sleep) => {
      const launchPreferences =
        sleep.model || sleep.effort
          ? {
              ...(sleep.model ? { model: sleep.model } : {}),
              ...(sleep.effort ? { effort: sleep.effort } : {})
            }
          : undefined
      return resumeConversation(
        runtimeResumeDeps(runtime, {
          userDataPath,
          launchCause: normalizeLaunchCause({
            trigger: 'hibernation-wake',
            actor: { kind: 'app' }
          }),
          ...(launchPreferences ? { launchPreferences } : {})
        }),
        { actor: WAKE_ACTOR, ref, dryRun: false }
      )
    },
    startedTerminal: (error) => error instanceof SessionManagePartialError,
    restartParked: (row) =>
      runtimeControlDeps(runtime).resume(
        {
          ...(row.paneKey ? { paneKey: row.paneKey } : {}),
          ...(row.tabId ? { tabId: row.tabId } : {}),
          // Why: only the window can tell its own sleep checkpoint and a PTY-less pane apart.
          onlySleptPane: true
        },
        normalizeLaunchCause({ trigger: 'hibernation-wake', actor: { kind: 'app' } })
      ),
    paneHasTerminal: (paneKey) => runtime.getTerminalHandleForPaneKey(paneKey) !== null,
    ledgerFor: (paneKey) => ledgerSourceForSession(paneKey, account),
    saveSleep: (entry, sleep) =>
      saveArtifactReviewSleep(profileId, userDataPath, entry.sourceKey, scope, entry, sleep),
    rebind: (entry, next) =>
      rebindArtifactSourceReview(profileId, userDataPath, entry.sourceKey, scope, entry, next),
    audit: (entry, summary) => {
      void sessionActionsLogFor(userDataPath)
        .append({
          actor: 'artifact-review',
          action: 'resume',
          target: { paneKey: entry.sourceReview.paneKey },
          summary,
          artifactReview: { slug: entry.slug, revision: entry.sourceReview.revision }
        })
        .catch(() => {})
    },
    now: () => Date.now()
  }
}
