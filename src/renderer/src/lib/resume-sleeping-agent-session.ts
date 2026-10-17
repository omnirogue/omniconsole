import { useAppStore } from '@/store'
import {
  agentProviderSessionsEqual,
  type SleepingAgentSessionRecord
} from '../../../shared/agent-session-resume'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status-types'
import {
  getProviderSessionClaimKey,
  isPassiveCompletedHibernationEvidence,
  recordAwaitsFirstRevealInOwnTab,
  recordPaneIsOwnedByPreservedPane
} from './sleeping-agent-pane-ownership'
import {
  launchSleepingAgentSession,
  type ResumeSleepingAgentSessionsOptions
} from './sleeping-agent-session-launch'
import { isStructuredAgentSyntheticSleepingRecord } from './structured-agent-synthetic-sleeping-record'
import { findUnhydratedHostMirrorForPane } from './host-mirrored-pane-liveness'
import { isMirrorRecordRelaunchRefused } from './mirror-record-relaunch-guard'
import { resumeSweepMayActOnWorkspace } from './resume-sweep-workspace-admission'
import { parkUntilHostSessionMirrorHydrates } from '@/runtime/host-session-mirror-hydration'
import { isRestoreFloodGuardOn } from './restore-flood-guard'
import { isPaneBoundToLivePty, resolveDoneRowAgentEvidence } from './live-provider-session-owner'
import {
  probeClearedSweepScope,
  probeDoneRowOwnerThenResume,
  type ResumeSweepScope
} from './resume-sleeping-done-owner-probe'

export type { ResumeSleepingAgentSessionsOptions } from './sleeping-agent-session-launch'

function clearPassiveCompletedRecordsForClaimKey(
  records: readonly SleepingAgentSessionRecord[],
  claimKey: string,
  keepPaneKey: string
): void {
  const state = useAppStore.getState()
  for (const record of records) {
    if (record.paneKey === keepPaneKey || !isPassiveCompletedHibernationEvidence(record)) {
      continue
    }
    if (getProviderSessionClaimKey(record) === claimKey) {
      state.clearSleepingAgentSession(record.paneKey)
    }
  }
}

function getCurrentPaneOwnedClaimKeys(records: readonly SleepingAgentSessionRecord[]): Set<string> {
  const state = useAppStore.getState()
  const keys = new Set<string>()
  for (const record of records) {
    if (
      state.sleepingAgentSessionsByPaneKey[record.paneKey] !== record ||
      isInvalidWorktreeActivationRecord(record) ||
      isPassiveCompletedHibernationEvidence(record)
    ) {
      continue
    }
    if (recordPaneIsOwnedByPreservedPane(record, state)) {
      keys.add(getProviderSessionClaimKey(record))
    }
  }
  return keys
}

function getNewestActiveRecordsByClaimKey(
  records: readonly SleepingAgentSessionRecord[]
): Map<string, SleepingAgentSessionRecord> {
  const newestRecords = new Map<string, SleepingAgentSessionRecord>()
  for (const record of records) {
    const claimKey = getProviderSessionClaimKey(record)
    const current = newestRecords.get(claimKey)
    if (
      !current ||
      record.capturedAt > current.capturedAt ||
      (record.capturedAt === current.capturedAt && record.updatedAt > current.updatedAt)
    ) {
      newestRecords.set(claimKey, record)
    }
  }
  return newestRecords
}

function getAgentStatusTabId(entry: {
  paneKey: string
  tabId?: string | undefined
}): string | null {
  if (entry.tabId) {
    return entry.tabId
  }
  const separatorIndex = entry.paneKey.indexOf(':')
  return separatorIndex === -1 ? null : entry.paneKey.slice(0, separatorIndex)
}

/** 'claimed': a live turn, queued startup or automatic resume owns the session (the record is a
 *  stale replay and clears). 'done-owner': a done row on a PTY this renderer still holds whose
 *  foreground sample shows the agent running there, so the record is neither launched nor
 *  cleared. 'probe-owner': the same done row with no foreground sample either way — no proof the
 *  agent runs (spec f), so the provider is asked before the record is resumed or skipped. */
type ProviderSessionClaim = 'claimed' | 'done-owner' | 'probe-owner' | null

function activeOrQueuedResumeClaimsProviderSession(
  record: SleepingAgentSessionRecord,
  state: ReturnType<typeof useAppStore.getState>,
  samePaneOwnsRecovery: boolean,
  probeCleared: boolean
): ProviderSessionClaim {
  const worktreeTabIds = new Set(
    (state.tabsByWorktree[record.worktreeId] ?? []).map((tab) => tab.id)
  )
  // Why: with the flood guard on, a done row whose pane still holds its PTY may own the session
  // (duplicate resumes, 2026-09-30) unless its foreground sample shows the shell back.
  const countsDoneOwners = isRestoreFloodGuardOn(state.settings)
  let doneOwner = false
  let unverifiedDoneOwner = false
  for (const entry of Object.values(state.agentStatusByPaneKey)) {
    // Why: only an owned pane needs its record; hidden/live panes still dedupe by status.
    if (samePaneOwnsRecovery && entry.paneKey === record.paneKey) {
      continue
    }
    if (
      !worktreeTabIds.has(getAgentStatusTabId(entry) ?? '') ||
      entry.worktreeId !== record.worktreeId ||
      entry.agentType !== record.agent ||
      !agentProviderSessionsEqual(record.agent, entry.providerSession, record.providerSession)
    ) {
      continue
    }
    if (entry.state !== 'done') {
      return 'claimed'
    }
    if (countsDoneOwners && isPaneBoundToLivePty(state, entry.paneKey)) {
      const evidence = resolveDoneRowAgentEvidence(state, entry.paneKey)
      doneOwner ||= evidence === 'running'
      unverifiedDoneOwner ||= evidence === 'unknown' && !probeCleared
    }
  }

  for (const [tabId, startup] of Object.entries(state.pendingStartupByTabId)) {
    if (
      worktreeTabIds.has(tabId) &&
      startup.launchAgent === record.agent &&
      agentProviderSessionsEqual(
        record.agent,
        startup.resumeProviderSession,
        record.providerSession
      )
    ) {
      return 'claimed'
    }
  }

  for (const [tabId, claim] of Object.entries(state.automaticAgentResumeClaimsByTabId)) {
    if (
      worktreeTabIds.has(tabId) &&
      claim.worktreeId === record.worktreeId &&
      claim.launchAgent === record.agent &&
      agentProviderSessionsEqual(record.agent, claim.providerSession, record.providerSession)
    ) {
      return 'claimed'
    }
  }
  return doneOwner ? 'done-owner' : unverifiedDoneOwner ? 'probe-owner' : null
}

// Why: an interrupted turn is still resumable — `claude --resume` reopens the transcript at the
// prompt — so discarding those records only stranded the session across wake and restart.
function isInvalidWorktreeActivationRecord(record: SleepingAgentSessionRecord): boolean {
  if (isStructuredAgentSyntheticSleepingRecord(record)) {
    return true
  }
  if (!record.origin && record.state === 'done') {
    return true
  }
  return (
    record.state !== 'done' && record.capturedAt - record.updatedAt > AGENT_STATUS_STALE_AFTER_MS
  )
}

function parkWorktreeResumeSweepUntilHostMirrorHydrates(
  worktreeId: string,
  environmentId: string | null,
  options: ResumeSleepingAgentSessionsOptions | undefined
): void {
  if (!environmentId) {
    // No paired runtime owns the workspace, so no verdict is coming; the next
    // activation re-runs this sweep once one does.
    return
  }
  parkUntilHostSessionMirrorHydrates(environmentId, worktreeId, () => {
    // Why: the mirror can settle long after the user moved on, so a replayed
    // resume must not steal the surface they are looking at now.
    const isActive = useAppStore.getState().activeWorktreeId === worktreeId
    // Why `skipClaimKeys` is dropped: it is a park-time snapshot of in-place
    // wakes, and a latch that has since failed must stay resumable here.
    resumeSleepingAgentSessionsForWorktree(worktreeId, {
      ...(options?.onSessionLaunched ? { onSessionLaunched: options.onSessionLaunched } : {}),
      ...(options?.deferStartupUntilRevealed ? { deferStartupUntilRevealed: true } : {}),
      ...(options?.deferStartupUntilRevealedFor
        ? { deferStartupUntilRevealedFor: options.deferStartupUntilRevealedFor }
        : {}),
      ...(isActive ? {} : { suppressNavigation: true })
    })
  })
}

export function resumeSleepingAgentSessionsForWorktree(
  worktreeId: string,
  options?: ResumeSleepingAgentSessionsOptions
): number {
  return runResumeSweep(worktreeId, options, {})
}

function runResumeSweep(
  worktreeId: string,
  options: ResumeSleepingAgentSessionsOptions | undefined,
  scope: ResumeSweepScope
): number {
  const state = useAppStore.getState()
  // Why: every branch below reads local rows as the verdict on what the execution host is running,
  // and before it answers "I hold no pane for this record" is `unverifiable`, not `exited`. Resuming
  // on it forks a second agent onto a transcript the host is still writing (STA-3500). Declining is
  // recoverable — the record survives, and the caller re-runs this sweep once the verdict lands.
  // Session parity, step 7: a workspace a paired computer owns (or none can settle) sweeps nothing;
  // mirror panes in this computer's workspaces keep the finer per-pane mirror park below.
  if (!resumeSweepMayActOnWorkspace(state, worktreeId)) {
    return 0
  }
  const worktreeRecords = Object.values(state.sleepingAgentSessionsByPaneKey)
    .filter((record) => record.worktreeId === worktreeId)
    .sort((a, b) => a.capturedAt - b.capturedAt || a.updatedAt - b.updatedAt)
  const validWorktreeRecords = worktreeRecords.filter(
    (record) => !isInvalidWorktreeActivationRecord(record)
  )
  const activeWorktreeRecords = validWorktreeRecords.filter(
    (record) => !isPassiveCompletedHibernationEvidence(record)
  )
  const activeClaimKeys = new Set(activeWorktreeRecords.map(getProviderSessionClaimKey))
  const newestActiveRecordByClaimKey = getNewestActiveRecordsByClaimKey(activeWorktreeRecords)
  const freshlyLaunchedClaimKeys = new Set<string>()
  // Why: a lazily restored tab owns its session until first reveal, across restarts (#857).
  const awaitingRevealClaimKeys = new Set(
    worktreeRecords
      .filter((record) => recordAwaitsFirstRevealInOwnTab(record, state))
      .map(getProviderSessionClaimKey)
  )

  let launched = 0
  for (const record of worktreeRecords) {
    const currentState = useAppStore.getState()
    if (currentState.sleepingAgentSessionsByPaneKey[record.paneKey] !== record) {
      continue
    }
    const claimKey = getProviderSessionClaimKey(record)
    if (scope.onlyClaimKeys && !scope.onlyClaimKeys.has(claimKey)) {
      continue
    }
    if (recordAwaitsFirstRevealInOwnTab(record, currentState)) {
      continue
    }
    if (awaitingRevealClaimKeys.has(claimKey)) {
      state.clearSleepingAgentSession(record.paneKey)
      continue
    }
    // Why: a mounted pane already consumed (or latched) the in-place
    // hibernation wake for this session; its record clears when that spawn
    // succeeds. Launching or clearing here would double-resume the session.
    if (options?.skipClaimKeys?.has(claimKey)) {
      continue
    }
    if (record.automaticResumeBlockedBy === 'legacy-orchestration-worker') {
      continue
    }
    if (isInvalidWorktreeActivationRecord(record)) {
      state.clearSleepingAgentSession(record.paneKey)
      continue
    }
    const unhydratedMirror = findUnhydratedHostMirrorForPane(record, currentState)
    if (unhydratedMirror) {
      // Why: pane ownership is undecidable until the mirror answers, and every
      // branch below — launch and clear alike — trusts that verdict. Take no
      // action on the record; the replay re-runs this pass with real evidence.
      parkWorktreeResumeSweepUntilHostMirrorHydrates(
        worktreeId,
        unhydratedMirror.environmentId,
        options
      )
      continue
    }
    const isPaneOwned = recordPaneIsOwnedByPreservedPane(record, currentState)
    if (isPassiveCompletedHibernationEvidence(record)) {
      // Why: completed-agent hibernation is passive history; activation should
      // only keep displayable evidence, never start new work from it.
      if (!isPaneOwned || activeClaimKeys.has(claimKey)) {
        state.clearSleepingAgentSession(record.paneKey)
      }
      continue
    }
    const providerSessionClaim = activeOrQueuedResumeClaimsProviderSession(
      record,
      currentState,
      isPaneOwned,
      scope.probeClearedClaimKeys?.has(claimKey) === true
    )
    if (providerSessionClaim === 'claimed') {
      // Why: main can replay the old wake record after the same provider
      // session was already queued in a fresh tab; clear the stale replay.
      state.clearSleepingAgentSession(record.paneKey)
      continue
    }
    if (providerSessionClaim === 'done-owner') {
      // Why: an ownership signal never deletes a resumable record; skip the launch only.
      continue
    }
    if (providerSessionClaim === 'probe-owner') {
      // Why: no pane may exist to run the reveal gate's probe for this record, so run it here and
      // re-run the sweep for this one session once the provider says the agent is not there.
      probeDoneRowOwnerThenResume(record, claimKey, isPaneOwned ? record.paneKey : '', () =>
        runResumeSweep(worktreeId, options, probeClearedSweepScope(claimKey))
      )
      continue
    }
    const paneOwnedClaimKeys = getCurrentPaneOwnedClaimKeys(activeWorktreeRecords)
    if (paneOwnedClaimKeys.has(claimKey)) {
      if (!isPaneOwned) {
        state.clearSleepingAgentSession(record.paneKey)
      }
      continue
    }
    if (freshlyLaunchedClaimKeys.has(claimKey)) {
      state.clearSleepingAgentSession(record.paneKey)
      continue
    }
    if (newestActiveRecordByClaimKey.get(claimKey) !== record) {
      state.clearSleepingAgentSession(record.paneKey)
      continue
    }
    // Why (A4): another computer's pane its owner no longer lists is that owner's closed
    // conversation; relaunching it here started it again there. The record stays for the owner's
    // complete membership to retire.
    if (isPaneOwned || isMirrorRecordRelaunchRefused(record, currentState)) {
      continue
    }
    if (launchSleepingAgentSession(record, options)) {
      launched += 1
      freshlyLaunchedClaimKeys.add(claimKey)
      clearPassiveCompletedRecordsForClaimKey(worktreeRecords, claimKey, record.paneKey)
    }
  }
  return launched
}
