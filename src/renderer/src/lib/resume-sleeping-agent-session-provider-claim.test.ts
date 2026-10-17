import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
import { resetDoneRowOwnerProbesForTests } from './resume-sleeping-done-owner-probe'

// What the provider probe (pty:hasPty + the PTY's foreground process) reports about a done row.
const probe = vi.hoisted(() => ({ owner: 'tab-2:probe-owner' as string | null, calls: 0 }))
vi.mock('./live-provider-session-owner', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  findLiveProviderSessionOwnerWithProbe: async () => {
    probe.calls += 1
    return probe.owner
  }
}))

const initialAppStoreState = useAppStore.getState()
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF_ID = '22222222-2222-4222-8222-222222222222'

beforeEach(() => {
  probe.owner = 'tab-2:probe-owner'
  probe.calls = 0
  useAppStore.setState({
    repos: [{ id: 'repo-1', path: '/repo', connectionId: null, executionHostId: 'local' }],
    worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/repo/wt' }] }
  } as never)
})

afterEach(() => {
  resetDoneRowOwnerProbesForTests()
  useAppStore.setState(initialAppStoreState, true)
})

async function settleProbe(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function makeRecord(
  paneKey: string,
  origin: SleepingAgentSessionRecord['origin'] = 'quit'
): SleepingAgentSessionRecord {
  return {
    paneKey,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'omp',
    providerSession: { key: 'session_id', id: 'sess-1' },
    prompt: 'finish the task',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    origin,
    launchConfig: {
      agentCommand: 'omp',
      agentArgs: '',
      agentEnv: { PI_CODING_AGENT_DIR: '/tmp/omp-agent' }
    }
  }
}

function makeTerminalTab(id: string): Record<string, unknown> {
  return {
    id,
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'shell',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function makeWorkingStatus(
  paneKey: string,
  tabId: string,
  record: SleepingAgentSessionRecord
): Record<string, unknown> {
  return {
    paneKey,
    tabId,
    worktreeId: 'wt-1',
    agentType: record.agent,
    providerSession: record.providerSession,
    prompt: record.prompt,
    state: 'working',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: []
  }
}

function makePreservedPaneState(record: SleepingAgentSessionRecord): Record<string, unknown> {
  return {
    activeWorktreeId: 'wt-1',
    activeTabType: 'terminal',
    activeTabId: 'tab-1',
    activeTabIdByWorktree: { 'wt-1': 'tab-1' },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' }
      }
    },
    sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
  }
}

describe('resume sleeping agent provider claims', () => {
  it('keeps a pane-owned quit record when its own persisted status is still working', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const record = makeRecord(paneKey)
    useAppStore.setState({
      ...makePreservedPaneState(record),
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1')] },
      agentStatusByPaneKey: { [paneKey]: makeWorkingStatus(paneKey, 'tab-1', record) }
    } as never)

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)

    const state = useAppStore.getState()
    expect(state.tabsByWorktree['wt-1']).toHaveLength(1)
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('clears the quit record when another pane already resumed the provider session', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const otherPaneKey = makePaneKey('tab-2', OTHER_LEAF_ID)
    const record = makeRecord(paneKey)
    useAppStore.setState({
      ...makePreservedPaneState(record),
      tabsByWorktree: {
        'wt-1': [makeTerminalTab('tab-1'), makeTerminalTab('tab-2')]
      },
      agentStatusByPaneKey: {
        [otherPaneKey]: makeWorkingStatus(otherPaneKey, 'tab-2', record)
      }
    } as never)

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)

    const state = useAppStore.getState()
    expect(state.tabsByWorktree['wt-1']).toHaveLength(2)
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('does not launch a hidden pane whose same provider session is still working', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const record = makeRecord(paneKey, 'worktree-sleep')
    useAppStore.setState({
      ...makePreservedPaneState(record),
      activeWorktreeId: 'wt-other',
      activeTabId: null,
      activeTabIdByWorktree: {},
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1')] },
      agentStatusByPaneKey: { [paneKey]: makeWorkingStatus(paneKey, 'tab-1', record) }
    } as never)

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)

    const state = useAppStore.getState()
    expect(state.tabsByWorktree['wt-1']).toHaveLength(1)
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  describe('a done row on a PTY this renderer still holds (restore flood guard on)', () => {
    // Tab 2 ran sess-1 and is still a live PTY with a 'done' row; tab 1's record has no pane.
    function seed(foreground?: { agent: string | null; shellForeground: boolean }): {
      record: SleepingAgentSessionRecord
    } {
      const otherPaneKey = makePaneKey('tab-2', OTHER_LEAF_ID)
      const record = makeRecord(makePaneKey('tab-1', LEAF_ID))
      useAppStore.setState({
        settings: { ...initialAppStoreState.settings, restoreFloodGuard: true },
        tabsByWorktree: {
          'wt-1': [makeTerminalTab('tab-1'), { ...makeTerminalTab('tab-2'), ptyId: 'pty-2' }]
        },
        ptyIdsByTabId: { 'tab-2': ['pty-2'] },
        agentStatusByPaneKey: {
          [otherPaneKey]: { ...makeWorkingStatus(otherPaneKey, 'tab-2', record), state: 'done' }
        },
        paneForegroundAgentByPaneKey: foreground ? { [otherPaneKey]: foreground } : {},
        sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
      } as never)
      return { record }
    }

    it('resumes when the foreground shows the shell back: the agent exited, the row is history', () => {
      const { record } = seed({ agent: null, shellForeground: true })
      expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(1)
      expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
    })

    it('neither launches nor deletes the record while the agent runs there', () => {
      const { record } = seed({ agent: 'omp', shellForeground: false })
      expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)
      // The ownership signal skips the launch; the record stays resumable.
      expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
      expect(useAppStore.getState().tabsByWorktree['wt-1']).toHaveLength(2)
      expect(probe.calls).toBe(0)
    })

    it('asks the provider about a done row with no foreground sample before skipping', async () => {
      // The agent in tab 2 may be idle at its prompt; the probe says it is.
      const { record } = seed(undefined)
      expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)
      await settleProbe()
      expect(probe.calls).toBe(1)
      expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
      expect(useAppStore.getState().tabsByWorktree['wt-1']).toHaveLength(2)
    })

    it('resumes the record once the probe shows the shell back in that PTY (spec f)', async () => {
      // No shell integration, never sampled while hidden: only the probe can tell.
      const { record } = seed(undefined)
      probe.owner = null
      expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)
      expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
      await settleProbe()
      expect(probe.calls).toBe(1)
      // Launched into a fresh tab, as when the foreground sample shows the shell.
      expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
    })
  })
})
