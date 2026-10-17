import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, type AppState } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
import { launchSleepingAgentSession } from './sleeping-agent-session-launch'
import { applyWebSessionTabsSnapshot } from '@/runtime/web-session-tabs-sync'
import { makeCreatedAgentWorktree } from '@/lib/worktree-activation-created-agent-test-state'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  hasHostSessionMirrorHydrated,
  markHostSessionMirrorHydrated,
  resetHostSessionMirrorHydrationForTests
} from '@/runtime/host-session-mirror-hydration'
import { clearRuntimeEnvironmentConnectionGenerationsForTests } from '@/store/slices/runtime-status'

// Deferring a mirrored pane's resume is only half the fix: whatever settles the
// mirror must replay the parked sweep, or the aug20 duplicate-launch defect is
// traded for a resume that never happens. These pin both halves plus the
// per-connection reset a host restart depends on.

const initialAppStoreState = useAppStore.getState()

const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const WEB_TAB_ID = 'web-terminal-host-tab-1'
const RUNTIME_ENV_ID = 'env-abfee683'
const WORKTREE_ID = makeCreatedAgentWorktree().id

function makeRuntimeOwnedWorktree(): ReturnType<typeof makeCreatedAgentWorktree> {
  return {
    ...makeCreatedAgentWorktree(),
    createdWithAgent: undefined,
    hostId: `runtime:${encodeURIComponent(RUNTIME_ENV_ID)}`
  }
}

function seedState(worktree: ReturnType<typeof makeCreatedAgentWorktree>): void {
  const state: Partial<AppState> = {
    repos: [
      {
        id: 'repo-1',
        path: path.join(path.sep, 'workspace', 'repo'),
        displayName: 'repo',
        badgeColor: '#000000',
        addedAt: 0
      }
    ],
    worktreesByRepo: { 'repo-1': [worktree] },
    activeRepoId: 'repo-1',
    activeWorktreeId: worktree.id,
    activeView: 'terminal',
    tabsByWorktree: {
      [worktree.id]: [{ id: WEB_TAB_ID, title: 'Codex', ptyId: null } as never]
    },
    unifiedTabsByWorktree: {
      [worktree.id]: [
        {
          id: `unified-${WEB_TAB_ID}`,
          contentType: 'terminal',
          entityId: WEB_TAB_ID,
          groupId: 'group-1'
        } as never
      ]
    },
    groupsByWorktree: {
      [worktree.id]: [
        {
          id: 'group-1',
          activeTabId: `unified-${WEB_TAB_ID}`,
          tabOrder: [`unified-${WEB_TAB_ID}`],
          recentTabIds: []
        } as never
      ]
    },
    activeGroupIdByWorktree: { [worktree.id]: 'group-1' },
    layoutByWorktree: {},
    openFiles: [],
    browserTabsByWorktree: {},
    activeFileIdByWorktree: {},
    activeBrowserTabIdByWorktree: {},
    activeTabTypeByWorktree: {},
    activeTabIdByWorktree: {},
    tabBarOrderByWorktree: {},
    pendingStartupByTabId: {},
    automaticAgentResumeClaimsByTabId: {},
    agentStatusByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {
      [WEB_TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        ptyIdsByLeafId: { [LEAF_ID]: 'pty-host-old-1' }
      } as never
    },
    settings: {
      agentCmdOverrides: {},
      setupScriptLaunchMode: 'new-tab'
    } as unknown as AppState['settings'],
    markWorktreeVisited: vi.fn(),
    recordWorktreeVisit: vi.fn(),
    refreshGitHubForWorktreeIfStale: vi.fn(),
    revealWorktreeInSidebar: vi.fn()
  }
  useAppStore.setState(state)
}

function seedSleepingRecord(worktreeId: string, sessionId: string): string {
  const paneKey = makePaneKey(WEB_TAB_ID, LEAF_ID)
  useAppStore.setState((s) => ({
    sleepingAgentSessionsByPaneKey: {
      ...s.sleepingAgentSessionsByPaneKey,
      [paneKey]: {
        paneKey,
        tabId: WEB_TAB_ID,
        worktreeId,
        agent: 'codex' as const,
        providerSession: { key: 'session_id' as const, id: sessionId },
        prompt: 'keep working',
        state: 'working' as const,
        origin: 'live' as const,
        capturedAt: 1000,
        updatedAt: 1000,
        terminalTitle: 'Codex'
      }
    }
  }))
  return paneKey
}

function retractMirroredTab(worktreeId: string): void {
  useAppStore.setState({ tabsByWorktree: { [worktreeId]: [] } })
}

/** No tab was created (that create is what reaches the owner), and nothing was queued to start. */
function expectNoRelaunch(worktreeId: string): void {
  const state = useAppStore.getState()
  expect(
    (state.tabsByWorktree[worktreeId] ?? []).filter((tab) => tab.id !== WEB_TAB_ID)
  ).toHaveLength(0)
  expect(Object.keys(state.automaticAgentResumeClaimsByTabId)).toHaveLength(0)
  expect(Object.keys(state.pendingStartupByTabId)).toHaveLength(0)
}

function connectRuntime(runtimeId: string): void {
  useAppStore.getState().setRuntimeEnvironmentStatus(RUNTIME_ENV_ID, {
    status: {
      runtimeId,
      rendererGraphEpoch: 1,
      graphStatus: 'live',
      authoritativeWindowId: 1,
      liveTabCount: 1,
      liveLeafCount: 1
    } as never,
    checkedAt: 1
  })
}

beforeEach(() => {
  resetHostSessionMirrorHydrationForTests()
  clearRuntimeEnvironmentConnectionGenerationsForTests()
})

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
  resetHostSessionMirrorHydrationForTests()
  clearRuntimeEnvironmentConnectionGenerationsForTests()
})

describe('parked mirrored-pane resume replay', () => {
  it('replays the deferred sweep but never relaunches a pane the mirror retracted', () => {
    const worktree = makeRuntimeOwnedWorktree()
    seedState(worktree)
    const paneKey = seedSleepingRecord(worktree.id, 'codex-session-replay-1')

    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()

    // The host answered: this pane is gone. Before A4 the replay relaunched it here — on the
    // host, the conversation the host had closed. Its owner's frame retires the record; until
    // then (this race) the record is kept and nothing is launched.
    retractMirroredTab(worktree.id)
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)

    expectNoRelaunch(worktree.id)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
  })

  it('never relaunches a surviving record of a pane the owner no longer lists on the next start', () => {
    const worktree = makeRuntimeOwnedWorktree()
    seedState(worktree)
    retractMirroredTab(worktree.id)
    connectRuntime('runtime-a')
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)
    const paneKey = seedSleepingRecord(worktree.id, 'codex-session-restart-1')

    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)
    expect(
      launchSleepingAgentSession(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]!)
    ).toBe(false)

    expectNoRelaunch(worktree.id)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
  })

  it('owner omits the pane: its frame retires the record and no relaunch is ever requested', () => {
    const worktree = makeRuntimeOwnedWorktree()
    seedState(worktree)
    const paneKey = seedSleepingRecord(worktree.id, 'codex-session-omitted-1')
    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)

    // The owner's complete membership for the workspace, without the pane.
    useAppStore.setState((state) =>
      applyWebSessionTabsSnapshot(
        state,
        {
          worktree: worktree.id,
          publicationEpoch: 'renderer:owner',
          snapshotVersion: 2,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        },
        RUNTIME_ENV_ID
      )
    )
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)
    resumeSleepingAgentSessionsForWorktree(worktree.id)

    expectNoRelaunch(worktree.id)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeUndefined()
  })

  it('keeps the record and launches nothing while the owner holds the pane as unverified', () => {
    const worktree = makeRuntimeOwnedWorktree()
    seedState(worktree)
    useAppStore.setState((state) => ({
      tabsByWorktree: {
        [worktree.id]: (state.tabsByWorktree[worktree.id] ?? []).map((tab) => ({
          ...tab,
          mirrorAbsenceUnverified: true as const
        }))
      }
    }))
    const paneKey = seedSleepingRecord(worktree.id, 'codex-session-unverified-1')
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)

    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)
    expect(useAppStore.getState().tabsByWorktree[worktree.id]?.map((tab) => tab.id)).toEqual([
      WEB_TAB_ID
    ])
    expect(Object.keys(useAppStore.getState().automaticAgentResumeClaimsByTabId)).toHaveLength(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
  })

  // Session parity (C4/F10, step 7): a listed pane with a dead PTY used to be the one mirror shape
  // this computer still relaunched. The workspace is the paired computer's, and launching the record
  // here started that computer's conversation again there — so the sweep declines; the owner
  // resumes its own, and the record stays for its conversation ledger to vouch for or retire.
  it('never relaunches a web-only mirror pane its owner lists from this computer, even when that PTY is dead', () => {
    const worktree = makeRuntimeOwnedWorktree()
    seedState(worktree)
    // A true mirror: its binding is the owner's remote PTY id, and the owner still lists the pane.
    useAppStore.setState((state) => ({
      terminalLayoutsByTabId: {
        ...state.terminalLayoutsByTabId,
        [WEB_TAB_ID]: {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          ptyIdsByLeafId: { [LEAF_ID]: `remote:${RUNTIME_ENV_ID}@@term-dead` }
        } as never
      }
    }))
    const paneKey = seedSleepingRecord(worktree.id, 'codex-session-listed-dead')
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)

    // No live handle for the listed pane: the conversation needs its resume, and its owner gives it.
    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)

    expectNoRelaunch(worktree.id)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
  })

  it('replays without relaunching when the mirror reports the host PTY live', () => {
    const worktree = makeRuntimeOwnedWorktree()
    seedState(worktree)
    const paneKey = seedSleepingRecord(worktree.id, 'codex-session-replay-2')

    resumeSleepingAgentSessionsForWorktree(worktree.id)

    // The host answered: the PTY is still attached to the mirrored pane.
    useAppStore.setState({ ptyIdsByTabId: { [WEB_TAB_ID]: ['pty-host-old-1'] } })
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)

    const after = useAppStore.getState()
    expect((after.tabsByWorktree[worktree.id] ?? []).map((tab) => tab.id)).toEqual([WEB_TAB_ID])
    expect(after.sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    expect(Object.keys(after.automaticAgentResumeClaimsByTabId)).toHaveLength(0)
  })

  it('drops the hydrated verdict when the host reconnects under a new runtime id', () => {
    connectRuntime('runtime-a')
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)
    expect(hasHostSessionMirrorHydrated(RUNTIME_ENV_ID, WORKTREE_ID)).toBe(true)

    // A host app restart: same environment, new connection, unknown PTYs again.
    connectRuntime('runtime-b')
    expect(hasHostSessionMirrorHydrated(RUNTIME_ENV_ID, WORKTREE_ID)).toBe(false)

    const worktree = makeRuntimeOwnedWorktree()
    seedState(worktree)
    const paneKey = seedSleepingRecord(worktree.id, 'codex-session-replay-3')

    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
  })
})
