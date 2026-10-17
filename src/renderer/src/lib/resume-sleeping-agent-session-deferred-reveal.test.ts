import { afterEach, describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import {
  isTabHeldUntilRevealed,
  markDeferredTabsRevealed,
  pendingStartupNeedsImmediateMount,
  resetDeferredStartupMountStateForTests,
  selectRevealDeferredTabIds,
  withholdUnrevealedDeferredTabs
} from '@/components/terminal/deferred-startup-mount'
import {
  hasPendingRetentionSpawnWork,
  selectRetentionForceParkedTerminalWorktrees,
  TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS
} from '@/components/terminal-pane/terminal-hidden-worktree-retention'
import { captureForceParkedWorktreeBuffers } from '@/components/terminal-pane/force-park-buffer-capture'
import { bindBuildColdRestoreAgentResumeStartup } from '@/components/terminal-pane/pty-connection/cold-restore-resume-startup'
import type { ConnectPanePtySession } from '@/components/terminal-pane/pty-connection/connect-pane-pty-session'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  resetDeferredStartupMountStateForTests()
  useAppStore.setState(initialAppStoreState, true)
})

function makeRecord(index: number): SleepingAgentSessionRecord {
  return {
    paneKey: `gone-tab-${index}:leaf-${index}`,
    tabId: `gone-tab-${index}`,
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: `sess-${index}` },
    prompt: 'finish the task',
    state: 'working',
    origin: 'worktree-sleep',
    capturedAt: index,
    updatedAt: index
  }
}

function seedOrphanedRecords(count: number, active: boolean): void {
  const records = Array.from({ length: count }, (_, index) => makeRecord(index + 1))
  useAppStore.setState({
    repos: [{ id: 'repo-1', path: '/repo', connectionId: null, executionHostId: 'local' }],
    worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/repo/wt' }] },
    activeWorktreeId: active ? 'wt-1' : 'wt-other',
    activeTabIdByWorktree: {},
    tabsByWorktree: { 'wt-1': [] },
    sleepingAgentSessionsByPaneKey: Object.fromEntries(
      records.map((record) => [record.paneKey, record])
    )
  } as never)
}

function launchedTabIds(): string[] {
  return (useAppStore.getState().tabsByWorktree['wt-1'] ?? []).map((tab) => tab.id)
}

function paneKeyForTab(tabId: string): string {
  const root = useAppStore.getState().terminalLayoutsByTabId[tabId]?.root
  if (root?.type !== 'leaf') {
    throw new Error(`tab ${tabId} has no single-leaf layout`)
  }
  return makePaneKey(tabId, root.leafId)
}

function revealDeferredTabIds(): ReadonlySet<string> {
  return new Set(selectRevealDeferredTabIds(useAppStore.getState()))
}

// Mirrors the pane that mounts on reveal: it looks up the record under its own pane key.
function coldRestoreStartupForPane(
  paneKey: string,
  paneStartup: ConnectPanePtySession['paneStartup']
): ReturnType<ConnectPanePtySession['buildColdRestoreAgentResumeStartup']> {
  const session = {
    pendingStartupCommand: null,
    cacheKey: paneKey,
    paneStartup,
    connectionId: null,
    executionHostId: null,
    projectRuntime: undefined,
    shellOverride: undefined,
    worktree: { path: '/repo' },
    getSleepingRecordForPane: (state: ReturnType<typeof useAppStore.getState>) => {
      const record = state.sleepingAgentSessionsByPaneKey[paneKey]
      return record ? { paneKey, record } : null
    },
    isLegacyWorkerAutomaticResumeBlocked: () => false
  } as unknown as ConnectPanePtySession
  bindBuildColdRestoreAgentResumeStartup(session)
  return session.buildColdRestoreAgentResumeStartup()
}

// Drops everything runtime-only; tabs, layouts and sleeping records are persisted.
function simulateRestart(): void {
  useAppStore.setState({
    pendingStartupByTabId: {},
    automaticAgentResumeClaimsByTabId: {},
    ptyIdsByTabId: {}
  } as never)
  resetDeferredStartupMountStateForTests()
}

describe('activation resume defers every restored session until it is revealed (#857)', () => {
  it('creates one lazy tab per orphaned record and re-keys each record onto its pane', () => {
    seedOrphanedRecords(4, true)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1', {
      deferStartupUntilRevealed: true
    })

    expect(launched).toBe(4)
    const state = useAppStore.getState()
    const tabIds = launchedTabIds()
    expect(tabIds).toHaveLength(4)
    for (const tabId of tabIds) {
      expect(state.pendingStartupByTabId[tabId]).toMatchObject({ deferUntilRevealed: true })
      expect(state.sleepingAgentSessionsByPaneKey[paneKeyForTab(tabId)]).toMatchObject({
        tabId,
        resumeOnFirstReveal: true
      })
    }
    expect(state.sleepingAgentSessionsByPaneKey['gone-tab-1:leaf-1']).toBeUndefined()
  })

  it('force-parks a worktree with only a deferred startup without losing its resume state', () => {
    seedOrphanedRecords(1, false)
    resumeSleepingAgentSessionsForWorktree('wt-1', { deferStartupUntilRevealed: true })
    const state = useAppStore.getState()
    const [tab] = state.tabsByWorktree['wt-1']!
    const paneKey = paneKeyForTab(tab.id)
    const startup = state.pendingStartupByTabId[tab.id]
    const sleepingRecord = state.sleepingAgentSessionsByPaneKey[paneKey]
    expect(startup).toMatchObject({ deferUntilRevealed: true })
    expect(sleepingRecord).toMatchObject({ tabId: tab.id, resumeOnFirstReveal: true })

    const parked = selectRetentionForceParkedTerminalWorktrees({
      worktrees: [
        {
          worktreeId: 'wt-1',
          hiddenSinceMs: 0,
          isVisible: false,
          shouldMeasureHiddenWorktree: false,
          hasActivityTerminalPortal: false,
          ordinaryParkingCovers: false,
          hasPendingSpawnWork: hasPendingRetentionSpawnWork(tab, state.pendingStartupByTabId)
        }
      ],
      parkingEnabled: true,
      retentionBudgetEnabled: true,
      nowMs: TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS
    })
    expect(parked.has('wt-1')).toBe(true)
    captureForceParkedWorktreeBuffers({ worktreeId: 'wt-1', tabIds: [tab.id], repos: [] })
    expect(
      withholdUnrevealedDeferredTabs('wt-1', new Set(), [tab], revealDeferredTabIds())
    ).toEqual(new Set())
    expect(useAppStore.getState().pendingStartupByTabId[tab.id]).toBe(startup)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBe(sleepingRecord)
  })

  it('mounts only the tab the activation shows; the rest wait for a click', () => {
    seedOrphanedRecords(4, true)
    resumeSleepingAgentSessionsForWorktree('wt-1', { deferStartupUntilRevealed: true })
    const state = useAppStore.getState()
    const tabIds = launchedTabIds()
    const activeTabId = state.activeTabIdByWorktree['wt-1']!
    expect(tabIds).toContain(activeTabId)

    // Mirrors Terminal's immediate set: the visible tab plus eager queued startups.
    const immediate = new Set([activeTabId])
    for (const tabId of tabIds) {
      if (pendingStartupNeedsImmediateMount(state.pendingStartupByTabId[tabId])) {
        immediate.add(tabId)
      }
    }
    expect([...immediate]).toEqual([activeTabId])
    const deferred = revealDeferredTabIds()
    markDeferredTabsRevealed(immediate, deferred)

    const mountable = withholdUnrevealedDeferredTabs(
      'wt-1',
      null,
      state.tabsByWorktree['wt-1'],
      deferred
    )
    expect([...mountable!]).toEqual([activeTabId])

    const clicked = tabIds.find((tabId) => tabId !== activeTabId)!
    expect(isTabHeldUntilRevealed(clicked, deferred)).toBe(true)
    markDeferredTabsRevealed([clicked], deferred)
    expect(isTabHeldUntilRevealed(clicked, deferred)).toBe(false)
  })

  it('reveals a lazy tab into its resume, and the spawn clears the record', () => {
    seedOrphanedRecords(1, true)
    resumeSleepingAgentSessionsForWorktree('wt-1', { deferStartupUntilRevealed: true })
    const [tabId] = launchedTabIds()
    const pending = useAppStore.getState().pendingStartupByTabId[tabId!]!

    const startup = coldRestoreStartupForPane(paneKeyForTab(tabId!), pending)

    expect(startup?.command).toBe(pending.command)
    expect(startup?.command).toContain('sess-1')
    // Why: hasSleepingRecord routes the spawn through clearSleepingRecordAfterColdRestoreSpawn.
    expect(startup?.hasSleepingRecord).toBe(true)
    expect(startup?.sleepingRecordEntry?.paneKey).toBe(paneKeyForTab(tabId!))
  })

  it('does not launch a duplicate when a second sweep runs before the click', () => {
    seedOrphanedRecords(3, true)
    resumeSleepingAgentSessionsForWorktree('wt-1', { deferStartupUntilRevealed: true })
    const before = useAppStore.getState().sleepingAgentSessionsByPaneKey

    const relaunched = resumeSleepingAgentSessionsForWorktree('wt-1', {
      deferStartupUntilRevealed: true
    })

    expect(relaunched).toBe(0)
    expect(launchedTabIds()).toHaveLength(3)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey).toEqual(before)
  })

  it('resumes (not a bare shell) when the first click comes after a restart', () => {
    seedOrphanedRecords(3, true)
    resumeSleepingAgentSessionsForWorktree('wt-1', { deferStartupUntilRevealed: true })
    const tabIds = launchedTabIds()
    simulateRestart()

    // The startup sweep after restart neither relaunches nor clears the lazy tabs' records.
    expect(
      resumeSleepingAgentSessionsForWorktree('wt-1', { deferStartupUntilRevealed: true })
    ).toBe(0)
    expect(launchedTabIds()).toEqual(tabIds)
    // Still lazy: nothing mounts until a tab is revealed.
    const deferred = revealDeferredTabIds()
    expect([...deferred].sort()).toEqual([...tabIds].sort())

    const clicked = tabIds[1]!
    const startup = coldRestoreStartupForPane(paneKeyForTab(clicked), null)
    expect(startup).not.toBeNull()
    expect(startup?.command).toContain('--resume')
    expect(startup?.command).toContain('sess-2')
    expect(startup?.hasSleepingRecord).toBe(true)
  })

  it('clears the record when the unclicked tab is closed', () => {
    seedOrphanedRecords(2, true)
    resumeSleepingAgentSessionsForWorktree('wt-1', { deferStartupUntilRevealed: true })
    const state = useAppStore.getState()
    const held = launchedTabIds().find((tabId) => tabId !== state.activeTabIdByWorktree['wt-1'])!
    const heldPaneKey = paneKeyForTab(held)

    state.closeTab(held)

    const after = useAppStore.getState()
    expect(after.pendingStartupByTabId[held]).toBeUndefined()
    expect(after.sleepingAgentSessionsByPaneKey[heldPaneKey]).toBeUndefined()
    expect(selectRevealDeferredTabIds(after)).not.toContain(held)
  })

  it('keeps background (mobile) wake eager', () => {
    seedOrphanedRecords(2, false)

    resumeSleepingAgentSessionsForWorktree('wt-1', { suppressNavigation: true })

    const state = useAppStore.getState()
    for (const tabId of launchedTabIds()) {
      expect(state.pendingStartupByTabId[tabId]?.deferUntilRevealed).toBeUndefined()
      expect(pendingStartupNeedsImmediateMount(state.pendingStartupByTabId[tabId])).toBe(true)
    }
    expect(Object.keys(state.sleepingAgentSessionsByPaneKey)).toEqual([])
  })

  it('defers per record under the restore flood guard, adding resumeOnFirstReveal additively', () => {
    seedOrphanedRecords(2, false)
    const records = Object.values(useAppStore.getState().sleepingAgentSessionsByPaneKey)
    const deferred = records[0]!

    resumeSleepingAgentSessionsForWorktree('wt-1', {
      suppressNavigation: true,
      deferStartupUntilRevealedFor: (record) => record.paneKey === deferred.paneKey
    })

    const state = useAppStore.getState()
    const tabIds = launchedTabIds()
    expect(tabIds).toHaveLength(2)
    const deferredTabs = tabIds.filter(
      (tabId) => state.pendingStartupByTabId[tabId]?.deferUntilRevealed === true
    )
    expect(deferredTabs).toHaveLength(1)
    // (g): the record keeps every field it had and only gains resumeOnFirstReveal + tabId, so
    // with restoreFloodGuard off the tab still resumes on its first reveal as before (#857).
    const [tabId] = deferredTabs
    const { paneKey: _oldPaneKey, tabId: _oldTabId, ...kept } = deferred
    expect(state.sleepingAgentSessionsByPaneKey[paneKeyForTab(tabId!)]).toEqual({
      ...kept,
      paneKey: paneKeyForTab(tabId!),
      tabId,
      resumeOnFirstReveal: true
    })
    useAppStore.setState({ settings: { restoreFloodGuard: false } as never })
    expect(revealDeferredTabIds().has(tabId!)).toBe(true)
  })
})
