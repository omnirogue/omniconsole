// @vitest-environment happy-dom
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationDialogProvider } from '@/components/confirmation-dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  EMPTY_AGENT_PANE_SNAPSHOT,
  type AgentPaneCard
} from '@/components/attention/agent-pane-snapshot'
import { emptySessionFolderMetadata } from '@/lib/session-folders'
import { personalViewStorageKey } from '@/lib/personal-view-storage'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import { SESSION_SIDEBAR_VIEW_STORAGE_KEY } from '@/lib/session-sidebar-view-storage'
import {
  addSessionTestRecord,
  addSessionTestTab,
  SESSION_TEST_LEAF,
  SESSION_TEST_WORKTREE,
  sessionTestSource,
  workingSessionTestSnapshot
} from '@/lib/sidebar-session-test-fixtures'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSelection } from '@/store/session-selection'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { useSessionTasks } from '@/store/session-task-store'

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  snapshot: null as unknown,
  titleRenders: new Map<string, number>()
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
// Why: every row render renders its title, so title renders count row renders.
vi.mock('./ConversationRowTitle', () => ({
  ConversationRowTitle: ({ title }: { title: string }) => {
    mocks.titleRenders.set(title, (mocks.titleRenders.get(title) ?? 0) + 1)
    return <span>{title}</span>
  }
}))
// Why: happy-dom has no layout, so the window is pinned: the first and last ten flat rows.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, enabled }: { count: number; enabled?: boolean }) => {
    const indexes =
      enabled === false
        ? []
        : [
            ...new Set(
              [...Array(Math.min(count, 10)).keys()].concat(
                [...Array(Math.min(count, 10)).keys()].map((index) => count - 1 - index)
              )
            )
          ].filter((index) => index >= 0)
    return {
      getTotalSize: () => count * 53,
      getVirtualItems: () =>
        indexes.map((index) => ({
          index,
          key: index,
          start: index * 53,
          size: 53,
          end: (index + 1) * 53,
          lane: 0
        })),
      measureElement: () => {},
      scrollToIndex: () => {}
    }
  }
}))
import SessionSidebar from './SessionSidebar'

// Why: these cases are about the full tree; the focus view has its own tests.
const fullTreeView = () => ({ ...emptySessionSidebarView(), flat: false, layout: 'full' as const })

const tree = () => (
  <TooltipProvider>
    <ConfirmationDialogProvider>
      <SessionSidebar />
    </ConfirmationDialogProvider>
  </TooltipProvider>
)

function tabId(index: number): string {
  return `tab-${String(index).padStart(3, '0')}`
}

function paneKey(index: number): string {
  return `${tabId(index)}:${SESSION_TEST_LEAF}`
}

function workingCard(index: number, bucket: 'working' | 'idle' = 'working'): AgentPaneCard {
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

function seedSessions(count: number): void {
  const source = sessionTestSource()
  for (let index = 0; index < count; index += 1) {
    addSessionTestRecord(source, addSessionTestTab(source, tabId(index)), `provider-${index}`)
  }
  mocks.snapshot = workingSessionTestSnapshot(source)
  mocks.state = {
    ...source,
    retainedAgentsByPaneKey: {},
    activeTabId: null,
    activeWorktreeId: null
  }
}

beforeEach(() => {
  localStorage.clear()
  mocks.titleRenders.clear()
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

describe('Conversations sidebar at 500 sessions', () => {
  it('keeps the optional Focus view at five lines without mounting hundreds of rows', async () => {
    seedSessions(500)
    useSessionSidebarView.setState({ view: { ...emptySessionSidebarView(), flat: false } })
    const cards = new Map(
      Array.from({ length: 500 }, (_, index) => [paneKey(index), workingCard(index)])
    )
    mocks.snapshot = { ...EMPTY_AGENT_PANE_SNAPSHOT, cardsByPaneKey: cards }
    render(tree())
    await act(async () => {})
    const lines = [...document.querySelectorAll('[data-session-focus-line]')]
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.length).toBeLessThanOrEqual(5)
    expect(document.querySelectorAll('[data-session-row]').length).toBe(0)
    expect(lines.at(-1)?.textContent).toMatch(/^Everything else · \d+ sessions?/)
  })

  it('windows the default flat list without folder headings or a phantom header', async () => {
    seedSessions(500)
    useSessionSidebarView.setState({ view: emptySessionSidebarView() })
    render(tree())
    await act(async () => {})
    expect(document.querySelectorAll('[data-session-row]').length).toBe(20)
    expect(document.querySelector('[data-session-focus-line]')).toBeNull()
    expect(document.querySelector('.group\\/session-header')).toBeNull()
    expect(document.querySelector('[data-session-list-flat]')).toBeTruthy()
  })

  it('windows the list and re-renders only the row whose pane status changed', async () => {
    seedSessions(500)
    useSessionSidebarView.setState({
      view: { ...fullTreeView(), collapsed: ['completed:open'] }
    })
    const cards = new Map(
      Array.from({ length: 500 }, (_, index) => [paneKey(index), workingCard(index)])
    )
    mocks.snapshot = { ...EMPTY_AGENT_PANE_SNAPSHOT, cardsByPaneKey: cards }
    const view = render(tree())
    await act(async () => {})

    const mounted = document.querySelectorAll('[data-session-row]').length
    expect(mounted).toBeGreaterThan(0)
    expect(mounted).toBeLessThan(40)
    const last = 'Session tab-499'
    expect(screen.getByRole('button', { name: `Open session ${last}` })).toBeTruthy()
    const before = new Map(mocks.titleRenders)

    const pinged = new Map(cards)
    // Keep Done expanded so the changed row stays visible after its turn stops.
    pinged.set(paneKey(499), workingCard(499, 'idle'))
    mocks.snapshot = { ...EMPTY_AGENT_PANE_SNAPSHOT, cardsByPaneKey: pinged }
    view.rerender(tree())
    await act(async () => {})

    const rerendered = [...mocks.titleRenders].filter(
      ([title, renders]) => renders !== before.get(title)
    )
    expect(rerendered.map(([title]) => title)).toEqual([last])
  })

  it('does not re-render any row when the parent re-renders with nothing new', async () => {
    seedSessions(500)
    const view = render(tree())
    await act(async () => {})
    const before = new Map(mocks.titleRenders)
    expect(before.size).toBeGreaterThan(0)
    view.rerender(tree())
    await act(async () => {})
    expect(new Map(mocks.titleRenders)).toEqual(before)
  })

  it('re-renders no row when a ping moves only what the tree never reads', async () => {
    seedSessions(500)
    const cards = new Map(
      Array.from({ length: 500 }, (_, index) => [paneKey(index), workingCard(index)])
    )
    mocks.snapshot = { ...EMPTY_AGENT_PANE_SNAPSHOT, cardsByPaneKey: cards }
    const view = render(tree())
    await act(async () => {})
    const before = new Map(mocks.titleRenders)

    // Why: unseen flags and pane titles ping constantly and group nothing.
    const pinged = new Map(cards)
    pinged.set(paneKey(499), { ...workingCard(499), unseen: true, title: 'Renamed pane' })
    mocks.snapshot = { ...EMPTY_AGENT_PANE_SNAPSHOT, cardsByPaneKey: pinged }
    view.rerender(tree())
    await act(async () => {})
    expect(new Map(mocks.titleRenders)).toEqual(before)
  })

  it('re-renders no row when the minute tick fires', async () => {
    vi.useFakeTimers()
    try {
      seedSessions(500)
      render(tree())
      await act(async () => {})
      const before = new Map(mocks.titleRenders)
      expect(before.size).toBeGreaterThan(0)
      await act(async () => {
        vi.advanceTimersByTime(60_000)
      })
      expect(new Map(mocks.titleRenders)).toEqual(before)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('group by task', () => {
  it('folds linked sessions under their task with live counts and remembers the choice', async () => {
    const user = userEvent.setup()
    seedSessions(3)
    useSessionTasks.setState({
      loaded: true,
      links: {
        [paneKey(0)]: { taskId: 'btk_launch1', title: 'Launch the site' },
        [paneKey(1)]: { taskId: 'btk_launch1', title: 'Launch the site' }
      }
    })
    mocks.snapshot = {
      ...EMPTY_AGENT_PANE_SNAPSHOT,
      cardsByPaneKey: new Map([
        [paneKey(0), workingCard(0)],
        [paneKey(1), { ...workingCard(1), workingMode: 'monitoring' }],
        [paneKey(2), workingCard(2)]
      ])
    }
    render(tree())

    await user.click(screen.getByRole('button', { name: 'Group by task' }))
    const task = screen.getByRole('group', { name: 'Launch the site' })
    expect(task.getAttribute('data-session-group-kind')).toBe('task')
    expect(within(task).getByRole('img', { name: '1 running' })).toBeTruthy()
    expect(within(task).getByRole('img', { name: '1 waiting' })).toBeTruthy()
    // Why: a task group starts folded to one line.
    expect(within(task).queryByRole('button', { name: 'Open session Session tab-000' })).toBeNull()
    expect(
      within(screen.getByRole('group', { name: 'Active' })).getByRole('button', {
        name: 'Open session Session tab-002'
      })
    ).toBeTruthy()

    await user.click(within(task).getByRole('button', { name: 'Expand Launch the site' }))
    expect(
      within(screen.getByRole('group', { name: 'Launch the site' })).getAllByRole('button', {
        name: /Open session Session tab-00[01]/
      })
    ).toHaveLength(2)
    expect(
      JSON.parse(localStorage.getItem(personalViewStorageKey(SESSION_SIDEBAR_VIEW_STORAGE_KEY))!)
    ).toMatchObject({ groupBy: 'task' })

    await user.click(screen.getByRole('button', { name: 'Group by task' }))
    expect(screen.queryByRole('group', { name: 'Launch the site' })).toBeNull()
  })

  it('finds a conversation by the title of the task it serves', async () => {
    const user = userEvent.setup()
    seedSessions(3)
    useSessionTasks.setState({
      loaded: true,
      links: { [paneKey(0)]: { taskId: 'btk_launch1', title: 'Launch the site' } }
    })
    render(tree())

    await user.click(screen.getByRole('button', { name: 'Group by task' }))
    // Why: searching the task name is how a person finds work they think of by its outcome.
    await user.type(screen.getByRole('textbox', { name: 'Find sessions' }), 'launch the')

    // Why under Titles: a search answers with its results by kind of match, not the tree.
    const found = screen.getByRole('group', { name: 'Titles' })
    expect(within(found).getByRole('button', { name: 'Open session Session tab-000' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open session Session tab-001' })).toBeNull()
  })
})
