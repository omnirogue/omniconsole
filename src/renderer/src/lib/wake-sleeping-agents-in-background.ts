import {
  WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT,
  type WakeHibernatedAgentsWorktreeDetail
} from '@/constants/terminal'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import { useAppStore } from '@/store'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
import { isRestoreFloodGuardOn } from './restore-flood-guard'
import { decideBackgroundResume } from './restore-flood-resume-verdict'
import {
  getProviderSessionClaimKey,
  isPassiveCompletedHibernationEvidence,
  recordAwaitsFirstRevealInOwnTab,
  recordPaneIsOwnedByPreservedPane
} from './sleeping-agent-pane-ownership'

type BackgroundSleepingAgentWakeDispatcherOptions = {
  isWorkspaceSessionReady?: () => boolean
  subscribeToStore?: (listener: () => void) => () => void
  wake?: (worktreeId: string) => void
}

/**
 * Buffers main's one-shot mobile wake until persisted sleeping records exist.
 * Why: the renderer can attach its IPC listener before workspace hydration;
 * dropping an early event leaves the phone connected to frozen slept panes.
 */
export function createBackgroundSleepingAgentWakeDispatcher(
  options: BackgroundSleepingAgentWakeDispatcherOptions = {}
): { request: (worktreeId: string) => void; dispose: () => void } {
  const pendingWorktreeIds = new Set<string>()
  const isWorkspaceSessionReady =
    options.isWorkspaceSessionReady ?? (() => useAppStore.getState().workspaceSessionReady)
  const subscribeToStore =
    options.subscribeToStore ?? ((listener) => useAppStore.subscribe(listener))
  const wake = options.wake ?? wakeSleepingAgentsForWorktreeInBackground
  let unsubscribeReadiness: (() => void) | null = null
  let disposed = false

  const flushWhenReady = (): void => {
    if (disposed || !isWorkspaceSessionReady()) {
      return
    }
    const worktreeIds = [...pendingWorktreeIds]
    pendingWorktreeIds.clear()
    unsubscribeReadiness?.()
    unsubscribeReadiness = null
    for (const worktreeId of worktreeIds) {
      wake(worktreeId)
    }
  }

  return {
    request(worktreeId) {
      if (disposed || !worktreeId) {
        return
      }
      if (isWorkspaceSessionReady()) {
        wake(worktreeId)
        return
      }
      pendingWorktreeIds.add(worktreeId)
      unsubscribeReadiness ??= subscribeToStore(flushWhenReady)
    },
    dispose() {
      disposed = true
      pendingWorktreeIds.clear()
      unsubscribeReadiness?.()
      unsubscribeReadiness = null
    }
  }
}

function getSleepingRecordTabId(record: SleepingAgentSessionRecord): string | null {
  return (
    record.tabId ??
    parsePaneKey(record.paneKey)?.tabId ??
    parseLegacyNumericPaneKey(record.paneKey)?.tabId ??
    null
  )
}

/** What automatic agent sleep leaves (toAutomaticSleepRecord): only opening its tab resumes it. */
function isAutomaticSleepRecord(record: SleepingAgentSessionRecord): boolean {
  return record.restoreOnTabOpenOnly === true && record.resumeOnFirstReveal === true
}

/**
 * Claims of agents automatic sleep put down, unless another record of the same session wakes here.
 * Why: a pane still mounted in the background holds an armed wake for its slept agent, and a phone
 * opening the workspace fired every one of them at once. Opening the tab still resumes it.
 */
function automaticSleepClaimKeys(records: readonly SleepingAgentSessionRecord[]): Set<string> {
  const wakingClaimKeys = new Set(
    records.filter((record) => !isAutomaticSleepRecord(record)).map(getProviderSessionClaimKey)
  )
  return new Set(
    records
      .filter(isAutomaticSleepRecord)
      .map(getProviderSessionClaimKey)
      .filter((claimKey) => !wakingClaimKeys.has(claimKey))
  )
}

function dispatchBackgroundMount(worktreeId: string, tabIds: readonly string[] | undefined): void {
  requestBackgroundTerminalWorktreeMount({ worktreeId, ...(tabIds ? { tabIds } : {}) })
}

function getCanonicalPassiveWakeRecords(
  records: readonly SleepingAgentSessionRecord[],
  alreadyClaimed: ReadonlySet<string>
): SleepingAgentSessionRecord[] {
  const activeClaimKeys = new Set(
    records
      .filter((record) => !isPassiveCompletedHibernationEvidence(record))
      .map(getProviderSessionClaimKey)
  )
  const recordsByClaim = new Map<string, SleepingAgentSessionRecord[]>()
  for (const record of records) {
    if (!isPassiveCompletedHibernationEvidence(record)) {
      continue
    }
    const claimKey = getProviderSessionClaimKey(record)
    if (alreadyClaimed.has(claimKey) || activeClaimKeys.has(claimKey)) {
      continue
    }
    const grouped = recordsByClaim.get(claimKey) ?? []
    grouped.push(record)
    recordsByClaim.set(claimKey, grouped)
  }

  const canonicalRecords: SleepingAgentSessionRecord[] = []
  const duplicatePaneKeys: string[] = []
  const state = useAppStore.getState()
  for (const grouped of recordsByClaim.values()) {
    const ordered = grouped
      .slice()
      .sort((a, b) => a.capturedAt - b.capturedAt || a.updatedAt - b.updatedAt)
    const liveTabIds = new Set(
      (state.tabsByWorktree[grouped[0]?.worktreeId ?? ''] ?? []).map((tab) => tab.id)
    )
    const canonical =
      ordered.find((record) => recordPaneIsOwnedByPreservedPane(record, state)) ??
      ordered.find((record) => {
        const tabId = getSleepingRecordTabId(record)
        return tabId !== null && liveTabIds.has(tabId)
      }) ??
      ordered.find((record) => getSleepingRecordTabId(record) !== null) ??
      ordered[0]
    if (!canonical) {
      continue
    }
    canonicalRecords.push(canonical)
    for (const duplicate of grouped) {
      if (duplicate !== canonical) {
        // Why: two cold panes mount after the event-scoped claim collector is
        // gone. Keep one provider-session record so only one can issue resume.
        duplicatePaneKeys.push(duplicate.paneKey)
      }
    }
  }
  state.clearSleepingAgentSessionsByPaneKey(duplicatePaneKeys)
  return canonicalRecords
}

/**
 * Wakes a worktree's slept agents on the desktop host renderer with NO desktop
 * navigation — used when a phone (`clientKind: 'mobile'`) opens the worktree.
 * Runs up to four steps, in order:
 *  (a) fire the armed cold-restore `--resume` of the worktree's mounted hidden
 *      hibernated panes (the primary wake mechanism, since those records are
 *      passive for path C). Panes that consume — or latch, when the wake races
 *      the hibernation kill — the in-place wake claim their provider sessions
 *      via the event detail. Agents automatic sleep put down are pre-claimed,
 *      so they stay asleep until their tab is opened;
 *  (b) background-mount the tabs holding passive hibernated records that are
 *      NOT currently mounted (post-restart / evicted) so they take the
 *      fresh-connect cold-restore path. The mount is targeted by tabId so one
 *      sleeping pane does not permanently mount every saved tab, and skips
 *      `restoreOnTabOpenOnly` records so an explicit workspace sleep is not
 *      undone wholesale by a phone opening the workspace;
 *  (c) resume the non-passive record classes (manual sleep of a still-working
 *      agent, `origin: 'quit'`) with navigation suppressed, skipping the
 *      claims from (a);
 *  (d) background-mount the tabs (c) created — they are `activate: false`, so
 *      nothing else would mount them and their queued `--resume` startup
 *      would otherwise never reach a PTY.
 * Woken PTYs auto-publish to mobile via the renderer graph republish, so no
 * spawn is awaited.
 */
export function wakeSleepingAgentsForWorktreeInBackground(worktreeId: string): void {
  const worktreeRecords = Object.values(
    useAppStore.getState().sleepingAgentSessionsByPaneKey
  ).filter((record) => record.worktreeId === worktreeId)
  // Why: nothing is slept here, so there is no wake work. Skipping is what keeps
  // a phone browsing many worktrees from permanently background-mounting each one
  // (and reattaching its PTYs) on the desktop host it is paired to.
  if (worktreeRecords.length === 0) {
    return
  }
  if (isRestoreFloodGuardOn(useAppStore.getState().settings)) {
    wakeSleepingAgentsForWorktreeUnderFloodGuard(worktreeId, worktreeRecords)
    return
  }

  // Pre-claimed, so neither the mounted panes' armed wakes nor the sweep below resume them.
  const wokenClaimKeys = automaticSleepClaimKeys(worktreeRecords)
  window.dispatchEvent(
    new CustomEvent<WakeHibernatedAgentsWorktreeDetail>(WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT, {
      detail: { worktreeId, wokenClaimKeys }
    })
  )
  // Why: only a passive completed-hibernation record has a not-yet-mounted pane
  // that needs a fresh-connect cold-restore (step b). Non-passive records are
  // recovered by step (c) into a fresh tab, mounted in step (d).
  const passiveTabIds = new Set<string>()
  let hasUntargetablePassiveRecord = false
  // Why: a workspace the user explicitly slept must not respawn every finished agent because a
  // phone opened it. Those panes cold-restore `--resume` when their own tab is opened, which is
  // also what the desktop does (#11598). Filtering before canonicalization keeps a lazy record
  // from winning — and deleting — the claim of a hibernated record that does need mounting.
  const backgroundWakeRecords = worktreeRecords.filter(
    (record) => record.restoreOnTabOpenOnly !== true
  )
  for (const record of getCanonicalPassiveWakeRecords(backgroundWakeRecords, wokenClaimKeys)) {
    const tabId = getSleepingRecordTabId(record)
    if (tabId) {
      passiveTabIds.add(tabId)
    } else {
      hasUntargetablePassiveRecord = true
    }
  }
  if (passiveTabIds.size > 0 || hasUntargetablePassiveRecord) {
    // Why: a record whose tab cannot be resolved falls back to the untargeted
    // whole-worktree mount rather than silently never waking.
    dispatchBackgroundMount(
      worktreeId,
      hasUntargetablePassiveRecord ? undefined : [...passiveTabIds]
    )
  }
  // Why: a phone opening the workspace is an explicit wake, so tabs a desktop activation restored
  // lazily (#857) mount now; their panes resume in place and the sweep below skips them. A record
  // a sleep left tab-open-only (a person's, or automatic agent sleep's) waits for its tab instead.
  const state = useAppStore.getState()
  const lazyTabIds = worktreeRecords
    .filter(
      (record) =>
        record.restoreOnTabOpenOnly !== true && recordAwaitsFirstRevealInOwnTab(record, state)
    )
    .flatMap((record) => (record.tabId ? [record.tabId] : []))
  if (lazyTabIds.length > 0) {
    dispatchBackgroundMount(worktreeId, lazyTabIds)
  }
  resumeSleepingAgentSessionsForWorktree(worktreeId, {
    suppressNavigation: true,
    skipClaimKeys: wokenClaimKeys,
    // Why: a mirror-parked sweep replays after this call returns, so each tab
    // must request its own mount instead of a batch collected here.
    onSessionLaunched: (tabId) => dispatchBackgroundMount(worktreeId, [tabId])
  })
}

/**
 * Step (b) under the restore flood guard: the passive hibernated and lazily restored (#857) tabs
 * whose own record a guard keeps resumable from the background (a touch in the last 10 minutes, a
 * reveal after it slept, a live interactive ask). Targeted by tab id, never the whole worktree;
 * tab-open-only records stay out as with the guard off (#11598). Nothing is deleted here: two
 * records of one session mount one tab, and the connect gate's claim dedupes the rest.
 */
function collectGuardKeptWakeTabIds(
  worktreeId: string,
  wokenClaimKeys: ReadonlySet<string>
): string[] {
  const state = useAppStore.getState()
  const liveTabIds = new Set((state.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id))
  const tabIds = new Set<string>()
  const claimKeys = new Set(wokenClaimKeys)
  for (const record of Object.values(state.sleepingAgentSessionsByPaneKey)) {
    const tabId = getSleepingRecordTabId(record)
    const claimKey = getProviderSessionClaimKey(record)
    if (
      record.worktreeId !== worktreeId ||
      record.restoreOnTabOpenOnly === true ||
      !tabId ||
      !liveTabIds.has(tabId) ||
      claimKeys.has(claimKey) ||
      (!isPassiveCompletedHibernationEvidence(record) &&
        !recordAwaitsFirstRevealInOwnTab(record, state))
    ) {
      continue
    }
    const verdict = decideBackgroundResume(state, {
      paneKey: record.paneKey,
      tabId,
      record,
      entry: state.agentStatusByPaneKey?.[record.paneKey] ?? null,
      visible: false
    })
    if (!verdict.hold) {
      claimKeys.add(claimKey)
      tabIds.add(tabId)
    }
  }
  return [...tabIds]
}

/**
 * The phone opening a workspace, under the restore flood guard. It opens no tab, so it is a
 * person's reveal for no tab: a passive hibernated or lazily restored (#857) tab is mounted only
 * when its own record passes the same verdict every other path applies (a recent touch, a reveal
 * after it slept, a live interactive ask), and the rest resume when their own tab is opened (on
 * the desktop, or the phone's per-terminal open, which reveals exactly that tab). Mounted
 * hibernated panes still get the in-place wake, and each decides for itself. Records that need a
 * new tab get one; a record the guard does not cover (a 'quit'/'live' agent that was mid-task,
 * G5) starts at once as before, the rest wait in a deferred tab.
 */
function wakeSleepingAgentsForWorktreeUnderFloodGuard(
  worktreeId: string,
  worktreeRecords: readonly SleepingAgentSessionRecord[]
): void {
  // Why pre-claimed here too: what automatic sleep put down waits for its own tab even when a
  // guard would keep it (a touch in the last 10 minutes); the workspace open reveals no tab.
  const wokenClaimKeys = automaticSleepClaimKeys(worktreeRecords)
  window.dispatchEvent(
    new CustomEvent<WakeHibernatedAgentsWorktreeDetail>(WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT, {
      detail: { worktreeId, wokenClaimKeys }
    })
  )
  const keptTabIds = collectGuardKeptWakeTabIds(worktreeId, wokenClaimKeys)
  if (keptTabIds.length > 0) {
    dispatchBackgroundMount(worktreeId, keptTabIds)
  }
  resumeSleepingAgentSessionsForWorktree(worktreeId, {
    suppressNavigation: true,
    skipClaimKeys: wokenClaimKeys,
    deferStartupUntilRevealedFor: (record) =>
      decideBackgroundResume(useAppStore.getState(), {
        paneKey: record.paneKey,
        tabId: getSleepingRecordTabId(record) ?? '',
        record,
        visible: false
      }).hold,
    onSessionLaunched: (tabId) => {
      // Why: a deferred tab starts on its first reveal; mounting it now would only hold it.
      if (useAppStore.getState().pendingStartupByTabId?.[tabId]?.deferUntilRevealed !== true) {
        dispatchBackgroundMount(worktreeId, [tabId])
      }
    }
  })
}
