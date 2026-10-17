import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore, makeTab, makeWorktree, seedStore } from './store-test-helpers'
import { shutdownBufferCaptures } from '@/components/terminal-pane/shutdown-buffer-captures'
import { recordAwaitsFirstRevealInOwnTab } from '@/lib/sleeping-agent-pane-ownership'
import {
  resetDeferredStartupMountStateForTests,
  selectRevealDeferredTabIds,
  withholdUnrevealedDeferredTabs
} from '@/components/terminal/deferred-startup-mount'
import {
  applySleepRuntimeRpcDefault,
  createStoreCascadesMockApi
} from './store-cascades-test-harness'

const mockUnregisterPtyDataHandlers = vi.hoisted(() => vi.fn<() => unknown[]>(() => []))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: mockUnregisterPtyDataHandlers
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const mockApi = createStoreCascadesMockApi()

const WT = 'repo1::/path/wt1'
const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = `tab-1:${LEAF}`
const SIBLING_LEAF = '22222222-2222-4222-8222-222222222222'

function seedDonePane(opts: { liveSibling?: boolean } = {}): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  // The split variant: a second leaf whose PTY (another agent, a dev server) keeps running.
  const sibling = opts.liveSibling === true
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    tabsByWorktree: { [WT]: [makeTab({ id: 'tab-1', worktreeId: WT, ptyId: 'pty-agent' })] },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: sibling
          ? {
              type: 'split',
              direction: 'horizontal',
              first: { type: 'leaf', leafId: LEAF },
              second: { type: 'leaf', leafId: SIBLING_LEAF }
            }
          : { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: sibling
          ? { [LEAF]: 'pty-agent', [SIBLING_LEAF]: 'pty-sibling' }
          : { [LEAF]: 'pty-agent' }
      }
    },
    ptyIdsByTabId: { 'tab-1': sibling ? ['pty-agent', 'pty-sibling'] : ['pty-agent'] }
  })
  store.getState().setAgentStatus(
    PANE,
    { state: 'done', prompt: 'resume target', agentType: 'codex', lastAssistantMessage: 'done' },
    'Codex',
    { updatedAt: 2000, stateStartedAt: 1000 },
    { tabId: 'tab-1', worktreeId: WT },
    { providerSession: { key: 'session_id', id: 'target-session' } }
  )
  return store
}

describe('automatic hibernation writes the manual lazy record shape', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRuntimeCompatibilityCacheForTests()
    mockApi.pty.kill.mockResolvedValue(undefined)
    applySleepRuntimeRpcDefault(mockApi)
    shutdownBufferCaptures.clear()
    resetDeferredStartupMountStateForTests()
  })

  it('stamps tab-open-only, first-reveal and its own tab, keeping history', async () => {
    const store = seedDonePane()
    await store.getState().shutdownCompletedAgentPaneForHibernation(WT, {
      paneKey: PANE,
      tabId: 'tab-1',
      leafId: LEAF,
      ptyId: 'pty-agent'
    })
    expect(mockApi.pty.kill).toHaveBeenCalledWith('pty-agent', { keepHistory: true })
    const record = store.getState().sleepingAgentSessionsByPaneKey[PANE]
    expect(record).toMatchObject({
      state: 'done',
      origin: 'worktree-sleep',
      restoreOnTabOpenOnly: true,
      resumeOnFirstReveal: true,
      tabId: 'tab-1',
      providerSession: { key: 'session_id', id: 'target-session' }
    })
    expect(record?.interrupted).toBeUndefined()
  })

  it('is treated as open-on-click: the tab waits for its reveal, no background mount', async () => {
    const store = seedDonePane()
    await store.getState().shutdownCompletedAgentPaneForHibernation(WT, {
      paneKey: PANE,
      tabId: 'tab-1',
      leafId: LEAF,
      ptyId: 'pty-agent'
    })
    const state = store.getState()
    const record = state.sleepingAgentSessionsByPaneKey[PANE]!
    // Activation sweeps skip it (the tab's own pane resumes it on first reveal)…
    expect(recordAwaitsFirstRevealInOwnTab(record, state as never)).toBe(true)
    // …and background mounts withhold the tab until a person reveals it.
    expect(selectRevealDeferredTabIds(state)).toContain('tab-1')
  })

  it('keeps a split tab mounted while a sibling pane still has a live PTY', async () => {
    const store = seedDonePane({ liveSibling: true })
    await store.getState().shutdownCompletedAgentPaneForHibernation(WT, {
      paneKey: PANE,
      tabId: 'tab-1',
      leafId: LEAF,
      ptyId: 'pty-agent'
    })
    const state = store.getState()
    expect(mockApi.pty.kill).not.toHaveBeenCalledWith('pty-sibling', expect.anything())
    expect(state.ptyIdsByTabId['tab-1']).toEqual(['pty-sibling'])
    expect(state.sleepingAgentSessionsByPaneKey[PANE]).toMatchObject({
      restoreOnTabOpenOnly: true,
      resumeOnFirstReveal: true,
      tabId: 'tab-1'
    })
    // Holding the tab would unmount the sibling's pane with it, so the tab is not held…
    const deferred = new Set(selectRevealDeferredTabIds(state))
    expect(deferred.has('tab-1')).toBe(false)
    // …and a background mount of the hidden worktree keeps the tab's surface.
    expect(withholdUnrevealedDeferredTabs(WT, null, state.tabsByWorktree[WT], deferred)).toBeNull()

    // Once the sibling exits too, nothing live is left and the tab waits for its reveal.
    store.setState((s) => ({
      ptyIdsByTabId: { ...s.ptyIdsByTabId, 'tab-1': [] },
      tabsByWorktree: {
        ...s.tabsByWorktree,
        [WT]: (s.tabsByWorktree[WT] ?? []).map((tab) => ({ ...tab, ptyId: null }))
      }
    }))
    expect(selectRevealDeferredTabIds(store.getState())).toContain('tab-1')
  })

  it('leaves a person’s manual sleep in its own shape', async () => {
    const store = seedDonePane()
    await store.getState().shutdownCompletedAgentPaneForHibernation(WT, {
      paneKey: PANE,
      tabId: 'tab-1',
      leafId: LEAF,
      ptyId: 'pty-agent',
      captureMode: 'manual-session-sleep'
    })
    const record = store.getState().sleepingAgentSessionsByPaneKey[PANE]
    expect(record).toMatchObject({ state: 'done', restoreOnTabOpenOnly: true })
    expect(record?.resumeOnFirstReveal).toBeUndefined()
  })
})
