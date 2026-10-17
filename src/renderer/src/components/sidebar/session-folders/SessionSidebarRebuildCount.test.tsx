// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationDialogProvider } from '@/components/confirmation-dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { EMPTY_AGENT_PANE_SNAPSHOT } from '@/components/attention/agent-pane-snapshot'
import { emptySessionFolderMetadata } from '@/lib/session-folders'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import {
  readSessionSidebarRowStats,
  resetSessionSidebarRowStats
} from '@/lib/session-sidebar-row-cache'
import { resetSidebarSessionStatusCacheForTest } from '@/lib/sidebar-session-status-projection'
import {
  addSessionTestRecord,
  addSessionTestTab,
  SESSION_TEST_LEAF,
  SESSION_TEST_WORKTREE,
  sessionTestSource
} from '@/lib/sidebar-session-test-fixtures'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSelection } from '@/store/session-selection'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { useSessionTasks } from '@/store/session-task-store'

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  snapshot: null as unknown
}))
vi.mock('@/store', () => {
  const completeState = () => ({
    rateLimits: {},
    getKnownWorktreeById: () => undefined,
    setSshTargetsMetadata: () => {},
    setContextualToursBlockingSurfaceVisible: () => {},
    ...mocks.state
  })
  return {
    useAppStore: Object.assign(
      (selector: (state: Record<string, unknown>) => unknown) => selector(completeState()),
      { getState: completeState }
    )
  }
})
vi.mock('@/components/attention/use-agent-pane-snapshot', () => ({
  useAgentPaneSnapshot: () => mocks.snapshot
}))
// Why: these cases are about sessions; the routine catalog read is covered by its own tests.
vi.mock('../routines/use-conversation-routines', () => {
  const routines = {
    automations: [],
    failed: false,
    target: { kind: 'local' },
    commands: {},
    selectedId: null,
    openingId: null,
    open: () => {}
  }
  return { useConversationRoutines: () => routines }
})
vi.mock('@/hooks/useWorkAgentCapabilities', () => ({
  useWorkAgentCapabilities: () => ({
    usable: [],
    capabilities: [],
    loading: false,
    refresh: async () => []
  })
}))
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, enabled }: { count: number; enabled?: boolean }) => ({
    getTotalSize: () => count * 53,
    getVirtualItems: () =>
      (enabled === false ? [] : [...Array(Math.min(count, 10)).keys()]).map((index) => ({
        index,
        key: index,
        start: index * 53,
        size: 53,
        end: (index + 1) * 53,
        lane: 0
      })),
    measureElement: () => {},
    scrollToIndex: () => {}
  })
}))
import SessionSidebar from './SessionSidebar'

// Why: these cases are about the full tree; the focus view has its own tests.
const fullTreeView = () => ({ ...emptySessionSidebarView(), layout: 'full' as const })

const tree = () => (
  <TooltipProvider>
    <ConfirmationDialogProvider>
      <SessionSidebar />
    </ConfirmationDialogProvider>
  </TooltipProvider>
)

const SESSIONS = 500

function tabId(index: number): string {
  return `tab-${String(index).padStart(3, '0')}`
}

function paneKey(index: number): string {
  return `${tabId(index)}:${SESSION_TEST_LEAF}`
}

function workingCard(index: number, bucket: 'working' | 'idle' = 'working') {
  return {
    paneKey: paneKey(index),
    worktreeId: SESSION_TEST_WORKTREE,
    tabId: tabId(index),
    leafId: SESSION_TEST_LEAF,
    agentType: 'codex',
    bucket,
    dotState: bucket,
    unseen: false,
    title: `Session ${tabId(index)}`,
    stateChangedAt: Date.now() - 1_000,
    repoName: 'Project A',
    worktreeName: 'main'
  }
}

function seedSessions(count: number): Map<string, ReturnType<typeof workingCard>> {
  const source = sessionTestSource()
  for (let index = 0; index < count; index += 1) {
    addSessionTestRecord(source, addSessionTestTab(source, tabId(index)), `provider-${index}`)
  }
  mocks.state = {
    ...source,
    retainedAgentsByPaneKey: {},
    activeTabId: null,
    activeWorktreeId: null
  }
  const cards = new Map(
    Array.from({ length: count }, (_, index) => [paneKey(index), workingCard(index)] as const)
  )
  mocks.snapshot = { ...EMPTY_AGENT_PANE_SNAPSHOT, cardsByPaneKey: cards }
  return cards
}

beforeEach(() => {
  localStorage.clear()
  resetSidebarSessionStatusCacheForTest()
  useSessionSelection.getState().set([])
  useSessionFolders.setState({ metadata: emptySessionFolderMetadata(), loaded: true, error: null })
  useSessionSidebarView.setState({
    view: fullTreeView(),
    archived: [],
    loaded: true,
    showHidden: false
  })
  useSessionTasks.setState({ links: {}, loaded: true })
  mocks.snapshot = EMPTY_AGENT_PANE_SNAPSHOT
  Object.assign(window, { api: {} })
})

afterEach(cleanup)

// Why these count classifications, not renders: structural sharing already hides the cost from
// React, so a render count stays green while all 500 rows are reclassified on every ping.
describe('Conversations sidebar rebuild cost at 500 sessions', () => {
  it('reclassifies only the row whose pane status changed', async () => {
    const cards = seedSessions(SESSIONS)
    const view = render(tree())
    await act(async () => {})
    expect(readSessionSidebarRowStats().computed).toBeGreaterThanOrEqual(SESSIONS)

    resetSessionSidebarRowStats()
    const pinged = new Map(cards)
    pinged.set(paneKey(499), workingCard(499, 'idle'))
    mocks.snapshot = { ...EMPTY_AGENT_PANE_SNAPSHOT, cardsByPaneKey: pinged }
    view.rerender(tree())
    await act(async () => {})

    const stats = readSessionSidebarRowStats()
    expect(stats.builds).toBeGreaterThanOrEqual(1)
    // One pane moved, so exactly one row is classified again — the other 499 are carried over.
    expect(stats.computed).toBe(1)
    expect(stats.reused).toBe(SESSIONS - 1)
  })

  it('reclassifies no row at all when the minute tick fires', async () => {
    vi.useFakeTimers()
    try {
      seedSessions(SESSIONS)
      render(tree())
      await act(async () => {})
      resetSessionSidebarRowStats()

      await act(async () => {
        vi.advanceTimersByTime(60_000)
      })

      const stats = readSessionSidebarRowStats()
      // Why: none of these rows can age out or wake on the clock, so the new `now` reaches
      // no row. Snoozed and finished rows stay clock-sensitive and do recompute.
      expect(stats.computed).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reclassifies nothing when a ping moves only what no row reads', async () => {
    const cards = seedSessions(SESSIONS)
    const view = render(tree())
    await act(async () => {})
    resetSessionSidebarRowStats()

    // Why: unseen flags and pane titles ping constantly and group nothing. The rest of the
    // card must be carried over untouched — a fresh one would also move `stateChangedAt`,
    // which the tree really does read.
    const pinged = new Map(cards)
    pinged.set(paneKey(499), { ...cards.get(paneKey(499))!, unseen: true, title: 'Renamed pane' })
    mocks.snapshot = { ...EMPTY_AGENT_PANE_SNAPSHOT, cardsByPaneKey: pinged }
    view.rerender(tree())
    await act(async () => {})

    expect(readSessionSidebarRowStats().computed).toBe(0)
  })
})
