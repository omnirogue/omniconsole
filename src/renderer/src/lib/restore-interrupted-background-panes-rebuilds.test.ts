// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { installInterruptedBackgroundPaneRestore } from './restore-interrupted-background-panes'
import { emptySessionSidebarView } from './session-sidebar-view'
import { conversationViewKey } from './conversation-view'
import { buildPaneSessions, type SidebarSessionSource } from './sidebar-sessions'
import type * as SidebarSessionsModule from './sidebar-sessions'
import { isPaneKeyPutAway } from './restore-flood-resume-verdict'
import {
  addSessionTestRecord,
  addSessionTestTab,
  sessionTestSource
} from './sidebar-session-test-fixtures'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'

const { mount } = vi.hoisted(() => ({ mount: vi.fn() }))
vi.mock('@/components/terminal/background-terminal-worktree-mount', () => ({
  requestBackgroundTerminalWorktreeMount: mount
}))
vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))
// Why a pass-through spy: the rows must be exactly the real ones; only the rebuilds are counted.
vi.mock('./sidebar-sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof SidebarSessionsModule>()
  return { ...actual, buildPaneSessions: vi.fn(actual.buildPaneSessions) }
})
const rebuilds = vi.mocked(buildPaneSessions)

/** Two mid-task panes the person archived, keyed the way the sidebar's Archive action keys them. */
function archivedWorkingPanes(): { paneKeys: string[]; keys: string[] } {
  const source: SidebarSessionSource = sessionTestSource()
  const working = ['tab-a', 'tab-b'].map((tabId, index): SleepingAgentSessionRecord => ({
    ...addSessionTestRecord(source, addSessionTestTab(source, tabId), `provider-${index}`),
    state: 'working',
    origin: 'quit'
  }))
  source.sleepingAgentSessionsByPaneKey = Object.fromEntries(
    working.map((record) => [record.paneKey, record])
  )
  useAppStore.setState({ ...source, workspaceSessionReady: true, settings: {} as never } as never)
  const rows = buildPaneSessions(useAppStore.getState())
  const keys = working.map((record) =>
    conversationViewKey(rows.find((row) => row.paneKey === record.paneKey)!)
  )
  useSessionSidebarView.setState({
    loaded: true,
    view: { ...emptySessionSidebarView(), archived: keys },
    archived: keys
  })
  return { paneKeys: working.map((record) => record.paneKey), keys }
}

beforeEach(() => {
  mount.mockReset()
  useSessionSidebarView.setState({ loaded: true, view: emptySessionSidebarView(), archived: [] })
})

describe('background interruption restore rebuilds pane rows only when they can change', () => {
  it('builds the pane rows once per pass, not once per put-away record', () => {
    archivedWorkingPanes()
    rebuilds.mockClear()
    const dispose = installInterruptedBackgroundPaneRestore()
    expect(mount).not.toHaveBeenCalled()
    expect(rebuilds).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('does not rebuild or re-check anything on an unrelated store change', () => {
    archivedWorkingPanes()
    const dispose = installInterruptedBackgroundPaneRestore()
    rebuilds.mockClear()
    // Typing writes this slice at least every 500 ms; it says nothing about any pane row.
    for (let keystroke = 1; keystroke <= 20; keystroke += 1) {
      useAppStore.setState({ lastTerminalInputAtByPaneKey: { 'tab-a:leaf': keystroke } })
    }
    expect(rebuilds).not.toHaveBeenCalled()
    expect(mount).not.toHaveBeenCalled()
    dispose()
  })

  it('re-checks a waiting put-away pane once when its rows can change, and still skips it', () => {
    const { paneKeys } = archivedWorkingPanes()
    const dispose = installInterruptedBackgroundPaneRestore()
    rebuilds.mockClear()
    // A pass input: the sleeping record is rewritten on each agent status update.
    const records = useAppStore.getState().sleepingAgentSessionsByPaneKey
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: {
        ...records,
        [paneKeys[0]]: { ...records[paneKeys[0]], updatedAt: 101 }
      }
    })
    expect(rebuilds).toHaveBeenCalledTimes(1)
    // A row input the pass itself does not read can still flip a waiting pane's verdict.
    useAppStore.setState({ agentStatusByPaneKey: {} })
    expect(rebuilds).toHaveBeenCalledTimes(2)
    expect(mount).not.toHaveBeenCalled()
    dispose()
  })

  it('ignores row-only changes once no pane is waiting put away', () => {
    archivedWorkingPanes()
    useSessionSidebarView.setState({ view: emptySessionSidebarView(), archived: [] })
    const dispose = installInterruptedBackgroundPaneRestore()
    expect(mount).toHaveBeenCalledTimes(2)
    rebuilds.mockClear()
    useAppStore.setState({ agentStatusByPaneKey: {} })
    expect(rebuilds).not.toHaveBeenCalled()
    dispose()
  })

  it('mounts a pane the person un-archives from the rows it already built', () => {
    const { keys } = archivedWorkingPanes()
    const dispose = installInterruptedBackgroundPaneRestore()
    rebuilds.mockClear()
    useSessionSidebarView.setState({
      view: { ...emptySessionSidebarView(), archived: [keys[1]] },
      archived: [keys[1]]
    })
    expect(rebuilds).not.toHaveBeenCalled()
    expect(mount).toHaveBeenCalledTimes(1)
    expect(mount).toHaveBeenCalledWith({ worktreeId: expect.any(String), tabIds: ['tab-a'] })
    dispose()
  })

  it('answers the restore flood guard from the same rows until they or the view change', () => {
    const { paneKeys } = archivedWorkingPanes()
    const dispose = installInterruptedBackgroundPaneRestore()
    rebuilds.mockClear()
    for (let ask = 0; ask < 5; ask += 1) {
      expect(isPaneKeyPutAway(paneKeys[0])).toBe(true)
      expect(isPaneKeyPutAway(paneKeys[1])).toBe(true)
    }
    useAppStore.setState({ lastTerminalInputAtByPaneKey: { 'tab-a:leaf': 1 } })
    expect(isPaneKeyPutAway(paneKeys[0])).toBe(true)
    expect(rebuilds).not.toHaveBeenCalled()
    // A change to the rows' inputs is never answered from the old rows.
    const records = useAppStore.getState().sleepingAgentSessionsByPaneKey
    useAppStore.setState({ sleepingAgentSessionsByPaneKey: { ...records } })
    expect(isPaneKeyPutAway(paneKeys[0])).toBe(true)
    expect(rebuilds).toHaveBeenCalledTimes(1)
    dispose()
  })
})
