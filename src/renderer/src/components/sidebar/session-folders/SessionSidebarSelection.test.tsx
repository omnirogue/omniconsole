// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationDialogProvider } from '@/components/confirmation-dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { useSessionSelection } from '@/store/session-selection'
import { emptySessionFolderMetadata } from '@/lib/session-folders'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import { personalViewStorageKey } from '@/lib/personal-view-storage'
import { SESSION_SIDEBAR_VIEW_STORAGE_KEY } from '@/lib/session-sidebar-view-storage'
import { EMPTY_AGENT_PANE_SNAPSHOT } from '@/components/attention/agent-pane-snapshot'
import { conversationViewKey } from '@/lib/conversation-view'
import { buildSidebarSessions } from '@/lib/sidebar-sessions'
import {
  workingSessionTestSnapshot,
  sessionTestSource,
  addSessionTestRecord,
  addSessionTestTab
} from '@/lib/sidebar-session-test-fixtures'

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  open: vi.fn(),
  runtime: vi.fn(),
  closeTerminalTab: vi.fn(),
  snapshot: null as unknown
}))
vi.mock('@/store', () => {
  const completeState = () => ({
    rateLimits: {},
    // Hover cards can open during slower keyboard gestures and read the workspace lineage.
    worktreeLineageById: {},
    sshTargetLabels: new Map(),
    runtimeEnvironments: [],
    getKnownWorktreeById: (id: string) =>
      Object.values((mocks.state.worktreesByRepo ?? {}) as Record<string, { id: string }[]>)
        .flat()
        .find((worktree) => worktree.id === id),
    setSshTargetsMetadata: vi.fn(),
    ...mocks.state
  })
  return {
    useAppStore: Object.assign(
      (selector: (state: Record<string, unknown>) => unknown) => selector(completeState()),
      { getState: completeState }
    )
  }
})
vi.mock('@/lib/activate-sidebar-session', () => ({ activateSidebarSession: mocks.open }))
// Why: the worker lineage read is not a send; this file asserts selection never reaches the runtime.
vi.mock('./use-worker-parent-leaves', () => {
  const none = new Map<string, string>()
  return { useWorkerParentLeaves: () => none }
})
// Why: the badge's read-only `nextSteps.list` poll is covered by next-steps-surfaces.test.tsx.
vi.mock('@/components/next-steps/NextStepsSessionBadge', () => ({
  NextStepsSessionBadge: () => null
}))
vi.mock('@/components/attention/use-agent-pane-snapshot', () => ({
  useAgentPaneSnapshot: () =>
    mocks.snapshot === EMPTY_AGENT_PANE_SNAPSHOT
      ? workingSessionTestSnapshot(mocks.state as unknown as ReturnType<typeof sessionTestSource>)
      : mocks.snapshot
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
vi.mock('@/components/terminal/terminal-tab-actions', () => ({
  closeTerminalTab: mocks.closeTerminalTab
}))
vi.mock('@/components/next-step/add-next/AddNextPanels', () => ({
  AddNextPanels: () => <div>Legacy recipient menu</div>
}))
import SessionSidebar from './SessionSidebar'

// Why: these cases are about the full tree; the focus view has its own tests.
const fullTreeView = () => ({ ...emptySessionSidebarView(), layout: 'full' as const, flat: false })

function renderSidebar() {
  return render(
    <TooltipProvider>
      <ConfirmationDialogProvider>
        <SessionSidebar />
      </ConfirmationDialogProvider>
    </TooltipProvider>
  )
}

const toggleKey = navigator.userAgent.includes('Mac') ? { metaKey: true } : { ctrlKey: true }

function openButton(label: string): HTMLButtonElement {
  return screen.getByRole('button', { name: `Open session ${label}` })
}

function rowOf(label: string): HTMLElement {
  return openButton(label).parentElement!
}

function selectedLabels(): string[] {
  return screen
    .getAllByRole('option')
    .filter((row) => row.getAttribute('aria-selected') === 'true')
    .map((row) => row.querySelector('[data-session-open] span span')!.textContent)
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  localStorage.setItem(
    personalViewStorageKey(SESSION_SIDEBAR_VIEW_STORAGE_KEY),
    JSON.stringify(fullTreeView())
  )
  useSessionSelection.getState().set([])
  Element.prototype.scrollIntoView = vi.fn()
  useSessionFolders.setState({ metadata: emptySessionFolderMetadata(), loaded: false, error: null })
  useSessionSidebarView.setState({
    view: fullTreeView(),
    archived: [],
    loaded: false,
    showHidden: false
  })
  mocks.snapshot = EMPTY_AGENT_PANE_SNAPSHOT
  const source = sessionTestSource()
  for (const id of ['tab-a', 'tab-b', 'tab-c']) {
    addSessionTestRecord(source, addSessionTestTab(source, id), `provider-${id}`)
  }
  mocks.state = {
    ...source,
    retainedAgentsByPaneKey: {},
    activeTabId: null,
    activeWorktreeId: null,
    setContextualToursBlockingSurfaceVisible: vi.fn()
  }
  mocks.open.mockResolvedValue(true)
  Object.assign(window, { api: { runtime: { call: mocks.runtime } } })
})

afterEach(cleanup)

describe('conversation multi-selection', () => {
  it('uses one selection for checkboxes, range gestures, and the bulk toolbar', async () => {
    const user = userEvent.setup()
    renderSidebar()
    await user.click(screen.getByRole('checkbox', { name: 'Select Session tab-a' }))
    expect(screen.getByText('1 selected')).toBeTruthy()
    fireEvent.click(openButton('Session tab-c'), { shiftKey: true })
    expect(screen.getByText('3 selected')).toBeTruthy()
    expect(
      screen.getByRole('checkbox', { name: 'Select Session tab-b' }).getAttribute('aria-checked')
    ).toBe('true')
    await user.click(screen.getByRole('checkbox', { name: 'Select Session tab-b' }))
    expect(selectedLabels()).toEqual(['Session tab-a', 'Session tab-c'])
    expect(screen.getByText('2 selected')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(
      screen.getByRole('checkbox', { name: 'Select Session tab-a' }).getAttribute('aria-checked')
    ).toBe('false')
    expect(screen.queryByRole('toolbar', { name: 'Selected conversations' })).toBeNull()
    expect(mocks.open).not.toHaveBeenCalled()
  })

  it('ranges with Shift+click, toggles with the platform modifier, and never opens or sends', () => {
    renderSidebar()
    const list = screen.getByRole('listbox', { name: 'Conversation list' })
    expect(list.getAttribute('aria-multiselectable')).toBe('true')
    fireEvent.click(openButton('Session tab-a'), { shiftKey: true })
    fireEvent.click(openButton('Session tab-c'), { shiftKey: true })
    expect(selectedLabels()).toEqual(['Session tab-a', 'Session tab-b', 'Session tab-c'])
    expect(rowOf('Session tab-b').hasAttribute('data-selected')).toBe(true)
    expect(screen.getByRole('toolbar', { name: 'Selected conversations' })).toBeTruthy()
    expect(screen.getByText('3 selected')).toBeTruthy()

    fireEvent.click(openButton('Session tab-b'), toggleKey)
    expect(selectedLabels()).toEqual(['Session tab-a', 'Session tab-c'])
    // Why: the range anchor moved to the toggled row, so the next Shift+click spans from it.
    fireEvent.click(openButton('Session tab-c'), { shiftKey: true })
    expect(selectedLabels()).toEqual(['Session tab-b', 'Session tab-c'])
    expect(mocks.open).not.toHaveBeenCalled()
    expect(mocks.runtime).not.toHaveBeenCalled()
    expect(mocks.closeTerminalTab).not.toHaveBeenCalled()
  })

  it('collapses the selection to a plainly clicked row and still opens it', () => {
    renderSidebar()
    fireEvent.click(openButton('Session tab-a'), { shiftKey: true })
    fireEvent.click(openButton('Session tab-c'), { shiftKey: true })
    fireEvent.click(openButton('Session tab-b'))
    expect(selectedLabels()).toEqual(['Session tab-b'])
    expect(mocks.open).toHaveBeenCalledOnce()
    // Why: one row picked on the way to opening it is not a batch; the bar stays away.
    expect(screen.queryByRole('toolbar', { name: 'Selected conversations' })).toBeNull()
    expect(
      rowOf('Session tab-b').querySelector('[data-session-open]')!.getAttribute('tabindex')
    ).toBe('0')
    expect(
      rowOf('Session tab-a').querySelector('[data-session-open]')!.getAttribute('tabindex')
    ).toBe('-1')
  })

  it('extends with Shift+Down, shrinks with Shift+Up and keeps the focus row in view', async () => {
    const user = userEvent.setup()
    renderSidebar()
    await user.click(openButton('Session tab-b'))
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}')
    expect(selectedLabels()).toEqual(['Session tab-b', 'Session tab-c'])
    expect(document.activeElement).toBe(openButton('Session tab-c'))
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    await user.keyboard('{Shift>}{ArrowUp}{/Shift}')
    expect(selectedLabels()).toEqual(['Session tab-b'])
    await user.keyboard('{Shift>}{ArrowUp}{/Shift}')
    expect(selectedLabels()).toEqual(['Session tab-a', 'Session tab-b'])
    expect(document.activeElement).toBe(openButton('Session tab-a'))
    // Why: the top is the top; the range does not wrap or grow the other way.
    await user.keyboard('{Shift>}{ArrowUp}{/Shift}')
    expect(selectedLabels()).toEqual(['Session tab-a', 'Session tab-b'])
    expect(mocks.open).toHaveBeenCalledOnce()
  })

  it('selects everything visible with the modifier+A and clears with Escape', async () => {
    const user = userEvent.setup()
    renderSidebar()
    await user.click(openButton('Session tab-a'))
    await user.keyboard(
      navigator.userAgent.includes('Mac') ? '{Meta>}a{/Meta}' : '{Control>}a{/Control}'
    )
    expect(selectedLabels()).toEqual(['Session tab-a', 'Session tab-b', 'Session tab-c'])
    expect(screen.getByText('3 selected')).toBeTruthy()
    await user.keyboard('{Escape}')
    expect(selectedLabels()).toEqual([])
    expect(screen.queryByRole('toolbar', { name: 'Selected conversations' })).toBeNull()
  })

  it('leaves the Find sessions input its own ArrowDown and Escape', async () => {
    const user = userEvent.setup()
    renderSidebar()
    fireEvent.click(openButton('Session tab-a'), { shiftKey: true })
    fireEvent.click(openButton('Session tab-b'), { shiftKey: true })
    const find = screen.getByRole('textbox', { name: 'Find sessions' })
    await user.click(find)
    const arrow = fireEvent.keyDown(find, { key: 'ArrowDown', shiftKey: true })
    const escape = fireEvent.keyDown(find, { key: 'Escape' })
    // Why: fireEvent returns false when a handler called preventDefault; the input keeps both keys.
    expect(arrow).toBe(true)
    expect(escape).toBe(true)
    expect(selectedLabels()).toEqual(['Session tab-a', 'Session tab-b'])

    // An editable element inside the list is equally off limits.
    const list = screen.getByRole('listbox', { name: 'Conversation list' })
    const input = document.createElement('input')
    list.append(input)
    expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(true)
    expect(selectedLabels()).toEqual(['Session tab-a', 'Session tab-b'])
  })

  it('prunes the selection to the rows a filter leaves on screen', async () => {
    const user = userEvent.setup()
    renderSidebar()
    fireEvent.click(openButton('Session tab-a'), { shiftKey: true })
    fireEvent.click(openButton('Session tab-c'), { shiftKey: true })
    expect(screen.getByText('3 selected')).toBeTruthy()
    await user.type(screen.getByRole('textbox', { name: 'Find sessions' }), 'tab-b')
    expect(selectedLabels()).toEqual(['Session tab-b'])
    expect(screen.getByText('1 selected')).toBeTruthy()
  })

  it('skips collapsed groups when walking a range', async () => {
    const user = userEvent.setup()
    useSessionFolders.setState({
      loaded: true,
      metadata: {
        ...emptySessionFolderMetadata(),
        folders: [{ id: '00000000-0000-4000-8000-000000000001', name: 'Later' }]
      }
    })
    renderSidebar()
    // File tab-b into Later; Later starts folded, so its row is not on screen.
    const rowB = within(rowOf('Session tab-b'))
    await user.click(rowB.getByRole('checkbox', { name: 'Select Session tab-b' }))
    await user.click(screen.getByRole('button', { name: 'Move to folder (1)' }))
    await user.click(screen.getByRole('menuitem', { name: 'Later' }))
    expect(screen.getByRole('button', { name: 'Expand Later' })).toBeTruthy()
    fireEvent.click(openButton('Session tab-a'), { shiftKey: true })
    fireEvent.click(openButton('Session tab-c'), { shiftKey: true })
    expect(selectedLabels()).toEqual(['Session tab-a', 'Session tab-c'])
    expect(screen.getByText('2 selected')).toBeTruthy()
  })

  it('selects everything in a folded folder from its menu, opening it on the way', async () => {
    const user = userEvent.setup()
    useSessionFolders.setState({
      loaded: true,
      metadata: {
        ...emptySessionFolderMetadata(),
        folders: [{ id: '00000000-0000-4000-8000-000000000001', name: 'Later' }]
      }
    })
    renderSidebar()
    fireEvent.click(openButton('Session tab-b'), { shiftKey: true })
    fireEvent.click(openButton('Session tab-c'), { shiftKey: true })
    await user.click(screen.getByRole('button', { name: 'Move to folder (2)' }))
    await user.click(screen.getByRole('menuitem', { name: 'Later' }))
    expect(screen.queryByRole('button', { name: 'Open session Session tab-b' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Options for Later' }))
    await user.click(screen.getByRole('menuitem', { name: 'Select all (2)' }))
    expect(screen.getByRole('button', { name: 'Collapse Later' })).toBeTruthy()
    expect(selectedLabels().sort()).toEqual(['Session tab-b', 'Session tab-c'])
    expect(screen.getByText('2 selected')).toBeTruthy()
    expect(mocks.open).not.toHaveBeenCalled()
  })

  it('hides the selection from the bulk bar and keeps the rest selected on a partial result', async () => {
    const user = userEvent.setup()
    renderSidebar()
    fireEvent.click(openButton('Session tab-a'), { shiftKey: true })
    fireEvent.click(openButton('Session tab-b'), { shiftKey: true })
    const hide = screen.getByRole('button', { name: 'Hide (2)' })
    await user.click(hide)
    const hidden = useSessionSidebarView.getState().view.hidden
    expect(hidden).toHaveLength(2)
    expect(hidden.every((key) => key.startsWith('conversation:'))).toBe(true)
    expect(screen.queryByRole('toolbar', { name: 'Selected conversations' })).toBeNull()
    expect(mocks.open).not.toHaveBeenCalled()
  })

  it('offers the hover eye on the row and Unarchive on a hand-archived row', async () => {
    const user = userEvent.setup()
    renderSidebar()
    await user.click(screen.getByRole('button', { name: 'Hide Session tab-a' }))
    expect(useSessionSidebarView.getState().view.hidden).toEqual([
      expect.stringContaining('conversation:')
    ])
    // Why (Sal, 2026-09-23): its tab is open, so it stays listed until the tab is closed.
    expect(screen.queryByRole('group', { name: 'Hidden (1)' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Show Session tab-a' })).toBeTruthy()

    fireEvent.click(openButton('Session tab-b'), toggleKey)
    await user.click(screen.getByRole('button', { name: 'Archive (1)' }))
    expect(useSessionSidebarView.getState().archived).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Show archived (1)' }))
    const archived = screen.getByRole('group', { name: 'Archived (1)' })
    await user.click(within(archived).getByRole('button', { name: 'Expand Archived (1)' }))
    // Why: the compact row is its name alone; the Archived caption waits in its hover card.
    expect(
      within(archived).getByRole('button', { name: 'Open session Session tab-b' })
    ).toBeTruthy()
    expect(within(archived).queryByText('Archived')).toBeNull()
    await user.click(within(archived).getByRole('button', { name: 'Unarchive Session tab-b' }))
    expect(useSessionSidebarView.getState().archived).toEqual([])
    expect(mocks.open).not.toHaveBeenCalled()
    expect(mocks.closeTerminalTab).not.toHaveBeenCalled()
  })
})

it('keeps archived sessions searchable and exposes both footer controls', async () => {
  const user = userEvent.setup()
  const source = sessionTestSource()
  const tab = addSessionTestTab(source)
  addSessionTestRecord(source, tab)
  mocks.state = {
    ...source,
    retainedAgentsByPaneKey: {},
    activeWorktreeId: null,
    getKnownWorktreeById: () => undefined,
    setContextualToursBlockingSurfaceVisible: vi.fn()
  }
  const paneKey = `${tab.id}:00000000-0000-4000-8000-000000000001`
  mocks.snapshot = {
    ...EMPTY_AGENT_PANE_SNAPSHOT,
    cardsByPaneKey: new Map([
      [
        paneKey,
        {
          paneKey,
          bucket: 'done',
          dotState: 'done',
          stateChangedAt: 1
        }
      ]
    ])
  }
  useSessionFolders.setState({
    loaded: true,
    metadata: {
      ...emptySessionFolderMetadata(),
      folders: [{ id: 'hidden', name: 'Hidden folder' }]
    }
  })
  useSessionSidebarView.setState({
    loaded: true,
    view: {
      ...fullTreeView(),
      hidden: ['folder:hidden'],
      archived: [conversationViewKey(buildSidebarSessions(source)[0]!)]
    }
  })
  renderSidebar()
  expect(screen.queryByRole('group', { name: 'Archived (1)' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Show 1 hidden' })).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'Show archived (1)' }))
  expect(
    screen.getByRole('group', { name: 'Archived (1)' }).hasAttribute('data-session-group-collapsed')
  ).toBe(true)
  await user.click(screen.getByRole('button', { name: 'Hide archived' }))
  await user.type(screen.getByRole('textbox', { name: 'Find sessions' }), 'Session tab-a')
  const found = screen.getByRole('group', { name: 'Titles' })
  expect(within(found).getByRole('button', { name: 'Open session Session tab-a' })).toBeTruthy()
})
