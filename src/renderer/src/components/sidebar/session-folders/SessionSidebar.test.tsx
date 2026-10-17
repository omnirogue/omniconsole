// @vitest-environment happy-dom
import { buildSidebarSessions } from '@/lib/sidebar-sessions'
import { conversationViewKey } from '@/lib/conversation-view'
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  within
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationDialogProvider } from '@/components/confirmation-dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { useSessionSelection } from '@/store/session-selection'
import { emptySessionFolderMetadata } from '@/lib/session-folders'
import { personalViewStorageKey } from '@/lib/personal-view-storage'
import { SESSION_FOLDERS_STORAGE_KEY } from '@/lib/session-folder-storage'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import { SESSION_SIDEBAR_VIEW_STORAGE_KEY } from '@/lib/session-sidebar-view-storage'
import { SESSION_GROUP_DRAG_TYPE, SESSION_ROW_DRAG_TYPE } from '@/lib/session-sidebar-drag'
import { EMPTY_AGENT_PANE_SNAPSHOT } from '@/components/attention/agent-pane-snapshot'
import { sessionOrganizationOwnershipMigration } from '@/lib/session-organization-ownership'
import {
  workingSessionTestSnapshot,
  sessionTestSource,
  addSessionTestRecord,
  addSessionTestTab,
  SESSION_TEST_WORKTREE
} from '@/lib/sidebar-session-test-fixtures'

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  open: vi.fn(),
  launch: vi.fn(),
  companyLaunch: vi.fn(),
  capabilities: [] as {
    id: 'codex'
    status: 'usable'
    models: { id: string; isDefault: boolean }[]
  }[],
  refreshCapabilities: vi.fn(),
  capabilitiesLoading: false,
  runtime: vi.fn(),
  snapshot: null as unknown
}))
vi.mock('@/store', () => {
  const completeState = () => ({
    rateLimits: {},
    getKnownWorktreeById: (id: string) =>
      Object.values((mocks.state.worktreesByRepo ?? {}) as Record<string, { id: string }[]>)
        .flat()
        .find((worktree) => worktree.id === id),
    setSshTargetsMetadata: vi.fn(),
    setContextualToursBlockingSurfaceVisible: () => {},
    ...mocks.state
  })
  return {
    useAppStore: Object.assign(
      (selector: (state: Record<string, unknown>) => unknown) => selector(completeState()),
      { getState: completeState, subscribe: () => () => {} }
    )
  }
})
// Why: happy-dom has no layout, so the real virtualizer measures a zero-height scroller and
// mounts no rows at all once a list passes SESSION_SIDEBAR_VIRTUALIZE_AFTER (80). Pin the window
// to the whole list — windowing itself is covered by SessionSidebarScale.test.tsx, while these
// cases are about what the launch path does with a hundred sessions already on screen.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, enabled }: { count: number; enabled?: boolean }) => ({
    getTotalSize: () => count * 53,
    getVirtualItems: () =>
      enabled === false
        ? []
        : [...Array(count).keys()].map((index) => ({
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
vi.mock('@/lib/activate-sidebar-session', () => ({ activateSidebarSession: mocks.open }))
// Why: the worker lineage read is not a command; these tests assert the exact runtime calls.
vi.mock('./use-worker-parent-leaves', () => {
  const none = new Map<string, string>()
  return { useWorkerParentLeaves: () => none }
})
// Why: the badge's read-only `nextSteps.list` poll is covered by next-steps-surfaces.test.tsx.
vi.mock('@/components/next-steps/NextStepsSessionBadge', () => ({
  NextStepsSessionBadge: () => null
}))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: mocks.launch }))
vi.mock('@/lib/start-company-session', () => ({
  startCompanySession: mocks.companyLaunch,
  createCompanySessionFolder: vi.fn()
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
    usable: mocks.capabilities,
    capabilities: mocks.capabilities,
    loading: mocks.capabilitiesLoading,
    readCurrent: () => mocks.capabilities,
    refresh: mocks.refreshCapabilities
  })
}))
import SessionSidebar from './SessionSidebar'

// Why: these cases are about the full tree; the focus view has its own tests.
const fullTreeView = () => ({ ...emptySessionSidebarView(), flat: false, layout: 'full' as const })
import { SidebarSessionSurface } from './SidebarSessionSurface'

function renderSidebar(technical = false) {
  return render(
    <TooltipProvider>
      <ConfirmationDialogProvider>
        <SessionSidebar technical={technical} />
      </ConfirmationDialogProvider>
    </TooltipProvider>
  )
}

// Why: happy-dom has no DragEvent, so pointer coordinates must be pinned onto the event by hand.
function fireDrag(
  type: 'dragStart' | 'dragOver' | 'drop',
  element: Element,
  init: { dataTransfer: unknown; clientY?: number }
): void {
  const event = createEvent[type](element, { dataTransfer: init.dataTransfer })
  if (init.clientY !== undefined) {
    Object.defineProperty(event, 'clientY', { value: init.clientY })
  }
  fireEvent(element, event)
}

function fakeDataTransfer(type: string, value: string) {
  return {
    types: [type],
    effectAllowed: 'move',
    dropEffect: 'none',
    setData: vi.fn(),
    getData: (candidate: string) => (candidate === type ? value : '')
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.capabilities = []
  mocks.capabilitiesLoading = false
  mocks.refreshCapabilities.mockResolvedValue([])
  mocks.launch.mockReturnValue({ tabId: 'new-tab' })
  mocks.companyLaunch.mockResolvedValue({ ok: true, workspaceId: 'work-root', tabId: 'new-tab' })
  localStorage.clear()
  localStorage.setItem(
    personalViewStorageKey(SESSION_SIDEBAR_VIEW_STORAGE_KEY),
    JSON.stringify(fullTreeView())
  )
  useSessionFolders.setState({ metadata: emptySessionFolderMetadata(), loaded: false, error: null })
  useSessionSidebarView.setState({
    view: fullTreeView(),
    loaded: false,
    showHidden: false
  })
  useSessionSelection.getState().set([])
  // Why: key moves are sent once per window; each case starts as a fresh window.
  sessionOrganizationOwnershipMigration.forgetSent()
  mocks.snapshot = EMPTY_AGENT_PANE_SNAPSHOT
  const source = sessionTestSource()
  addSessionTestRecord(source, addSessionTestTab(source))
  mocks.state = {
    ...source,
    retainedAgentsByPaneKey: {},
    activeTabId: null,
    activeWorktreeId: null,
    getKnownWorktreeById: () => undefined
  }
  mocks.open.mockResolvedValue(true)
  Object.assign(window, { api: { runtime: { call: mocks.runtime } } })
})

afterEach(cleanup)

// Why excluded: showing a provider-backed row moves its pane history to the provider key.
const KEY_MIGRATION = 'sessionOrganization.migrateKeys'

/** Only the person's organization records reach the runtime: no workflow or runtime command. */
const recordedChanges = (): string[] =>
  mocks.runtime.mock.calls
    .filter(([{ method }]) => method !== KEY_MIGRATION)
    .map(([{ method: m, params: p }]) =>
      m === 'sessionOrganization.settle' && p.change.executor.via === 'sidebar' ? p.change.kind : m
    )

describe('primary session sidebar controls', () => {
  it('lists filed sessions once by default even when their folder is collapsed, and keeps filing when switching views', () => {
    const folderId = '00000000-0000-4000-8000-000000000001'
    const key = conversationViewKey(
      buildSidebarSessions(mocks.state as unknown as Parameters<typeof buildSidebarSessions>[0])[0]!
    )
    const metadata = {
      ...emptySessionFolderMetadata(),
      folders: [{ id: folderId, name: 'Planning' }],
      membership: { [key]: folderId }
    }
    useSessionFolders.setState({ metadata, loaded: true })
    useSessionSidebarView.setState({
      view: { ...emptySessionSidebarView(), collapsed: [`folder:${folderId}`] },
      loaded: true
    })
    renderSidebar()
    expect(screen.getAllByRole('button', { name: 'Open session Session tab-a' })).toHaveLength(1)
    expect(document.querySelector('[data-session-focus-line]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Collapse all' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'New folder' })).toBeNull()
    expect(screen.queryByRole('group', { name: 'Planning' })).toBeNull()
    act(() => useSessionSidebarView.getState().setViewChoice('folders'))
    expect(screen.getByRole('group', { name: 'Planning' })).toBeTruthy()
    act(() => useSessionSidebarView.getState().setViewChoice('flat'))
    expect(screen.getAllByRole('button', { name: 'Open session Session tab-a' })).toHaveLength(1)
    expect(useSessionFolders.getState().metadata).toEqual(metadata)
    expect(recordedChanges()).toEqual([])
  })
  it('omits bulk controls and empty heading space without explicit selection', () => {
    renderSidebar()
    expect(screen.queryByRole('toolbar', { name: 'Session bulk actions' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Select sessions · bulk actions' })).toBeNull()
    const input = screen.getByRole('textbox', { name: 'Find sessions' })
    expect(input.parentElement!.firstElementChild).toBe(input)
    const key = screen.getByRole('option').getAttribute('data-session-key')!
    act(() =>
      useSessionSelection
        .getState()
        .setGesture({ selected: new Set([key]), anchor: key, focus: key }, false)
    )
    expect(useSessionSelection.getState().keys).toEqual([key])
    expect(screen.queryByRole('toolbar', { name: 'Session bulk actions' })).toBeNull()
  })

  it('renders one bulk action bar after the list and removes it when cleared', async () => {
    const source = sessionTestSource()
    addSessionTestRecord(source, addSessionTestTab(source, 'tab-a'), 'provider-a')
    addSessionTestRecord(source, addSessionTestTab(source, 'tab-b'), 'provider-b')
    mocks.state = { ...mocks.state, ...source }
    const user = userEvent.setup()
    renderSidebar()
    await user.click(screen.getByRole('button', { name: /Select All/ }))
    expect(screen.getByText('2 selected')).toBeTruthy()
    const input = screen.getByRole('textbox', { name: 'Find sessions' })
    const toolbar = screen.getByRole('toolbar', { name: 'Selected conversations' })
    expect(screen.queryByRole('toolbar', { name: 'Session bulk actions' })).toBeNull()
    for (const name of ['Hide (2)', 'Archive (2)']) {
      const button = within(toolbar).getByRole('button', { name })
      expect(input.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    expect(screen.queryByRole('button', { name: 'Select sessions · bulk actions' })).toBeNull()
    await user.click(within(toolbar).getByRole('button', { name: 'Clear selection' }))
    expect(screen.queryByRole('toolbar', { name: 'Selected conversations' })).toBeNull()
    expect(input.parentElement!.firstElementChild).toBe(input)
  })

  it.each([false, true])(
    'places all four controls between search and Select All (technical: %s)',
    (technical) => {
      renderSidebar(technical)
      const input = screen.getByRole('textbox', { name: 'Find sessions' })
      const selectAll = screen.getByRole('button', { name: /Select All/ })
      for (const name of ['Group by task', 'Collapse all', 'New folder', 'New conversation']) {
        const button = screen.getByRole('button', { name })
        expect(
          input.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy()
        expect(
          button.compareDocumentPosition(selectAll) & Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy()
      }
      expect(Boolean(screen.queryByText('Sessions', { selector: 'span' }))).toBe(technical)
    }
  )

  it('launches once from a rendered 100-session list without scanning again or opening another session', () => {
    const source = sessionTestSource()
    for (let index = 0; index < 100; index += 1) {
      addSessionTestRecord(source, addSessionTestTab(source, `tab-${index}`), `provider-${index}`)
    }
    mocks.state = {
      ...source,
      retainedAgentsByPaneKey: {},
      activeWorktreeId: SESSION_TEST_WORKTREE,
      activeGroupIdByWorktree: { [SESSION_TEST_WORKTREE]: 'group-1' },
      settings: { defaultTuiAgent: 'codex', experimentalNativeChat: true }
    }
    mocks.capabilities = [
      {
        id: 'codex',
        status: 'usable',
        models: [{ id: 'gpt-6-astra', isDefault: true }]
      }
    ]
    mocks.refreshCapabilities.mockImplementation(() => new Promise(() => {}))
    renderSidebar()
    expect(screen.getAllByRole('option')).toHaveLength(100)

    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }))

    expect(mocks.companyLaunch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ agent: 'codex', company: null, domain: null })
    )
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(mocks.refreshCapabilities).not.toHaveBeenCalled()
    expect(mocks.open).not.toHaveBeenCalled()
    expect(screen.getAllByRole('option')).toHaveLength(100)
  })

  it('waits for cold discovery, then starts at Work without adding a draft to the active workspace', async () => {
    mocks.capabilitiesLoading = true
    const source = sessionTestSource()
    for (let index = 0; index < 100; index += 1) {
      addSessionTestRecord(source, addSessionTestTab(source, `tab-${index}`), `provider-${index}`)
    }
    const createTab = vi.fn()
    mocks.state = {
      ...source,
      retainedAgentsByPaneKey: {},
      activeWorktreeId: SESSION_TEST_WORKTREE,
      activeGroupIdByWorktree: { [SESSION_TEST_WORKTREE]: 'group-1' },
      settings: { defaultTuiAgent: 'codex', experimentalNativeChat: false },
      createTab
    }
    let resolve!: (entries: typeof mocks.capabilities) => void
    mocks.refreshCapabilities.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    renderSidebar()
    expect(screen.getAllByRole('option')).toHaveLength(100)
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }))
    expect(mocks.refreshCapabilities).toHaveBeenCalledOnce()
    expect(createTab).not.toHaveBeenCalled()
    expect(mocks.companyLaunch).not.toHaveBeenCalled()
    await act(async () => {
      resolve([
        {
          id: 'codex',
          status: 'usable',
          models: [{ id: 'gpt-6-astra', isDefault: true }]
        }
      ])
    })
    expect(mocks.companyLaunch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ agent: 'codex', company: null, domain: null })
    )
    expect(createTab).not.toHaveBeenCalled()
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(screen.getAllByRole('option')).toHaveLength(100)
  })

  it('selects and clears every matching row without opening or dispatching a session', async () => {
    const user = userEvent.setup()
    const source = sessionTestSource()
    addSessionTestRecord(source, addSessionTestTab(source, 'tab-a'), 'provider-a')
    addSessionTestRecord(source, addSessionTestTab(source, 'tab-b'), 'provider-b')
    mocks.state = {
      ...source,
      retainedAgentsByPaneKey: {},
      activeWorktreeId: null,
      getKnownWorktreeById: () => undefined
    }
    renderSidebar()
    await act(async () => {})
    // Why: the one call is the key migration recordedChanges leaves out, sent once per window.
    expect(mocks.runtime.mock.calls.map(([call]) => call.method)).toEqual([KEY_MIGRATION])

    await user.type(screen.getByRole('textbox', { name: 'Find sessions' }), 'Session')
    await user.click(screen.getByRole('button', { name: /Select All/ }))

    expect(useSessionSelection.getState().keys).toHaveLength(2)
    expect(screen.getByText('2 selected')).toBeTruthy()
    expect(mocks.open).not.toHaveBeenCalled()
    expect(mocks.runtime.mock.calls.map(([call]) => call.method)).toEqual([KEY_MIGRATION])

    await user.click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(useSessionSelection.getState().keys).toEqual([])
  })

  it('creates, files into, renames and deletes a folder through the real controls without activating work', async () => {
    const user = userEvent.setup()
    const initialSessions = JSON.stringify(mocks.state)
    renderSidebar()
    expect(screen.getByRole('group', { name: 'Active' })).toBeTruthy()
    // Why: the tab above the list is the sidebar's one "Conversations"; the list repeats it nowhere.
    expect(screen.queryAllByText(/conversations/i)).toEqual([])
    await user.click(screen.getByRole('button', { name: 'New folder' }))
    await user.type(screen.getByRole('textbox', { name: 'New folder' }), 'Planning')
    await user.keyboard('{Enter}')
    expect(useSessionFolders.getState().metadata.folders[0].name).toBe('Planning')
    const planning = screen.getByRole('group', { name: 'Planning' })
    expect(
      within(planning).queryByRole('button', { name: 'Open session Session tab-a' })
    ).toBeNull()

    // Why: the row's ⋯ menu is color and Archive only; filing goes through the selection bar.
    await user.click(screen.getByRole('checkbox', { name: 'Select Session tab-a' }))
    await user.click(screen.getByRole('button', { name: 'Move to folder (1)' }))
    await user.click(screen.getByRole('menuitem', { name: 'Planning' }))
    // Why: a new folder starts folded like every other.
    await user.click(screen.getByRole('button', { name: 'Expand Planning' }))
    expect(
      within(screen.getByRole('group', { name: 'Planning' })).getByRole('button', {
        name: 'Open session Session tab-a'
      })
    ).toBeTruthy()
    // Why: the remainder stays as the unfile drop target once folders exist, now empty.
    expect(screen.getAllByRole('button', { name: 'Open session Session tab-a' })).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Options for Planning' }))
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
    await user.clear(screen.getByRole('textbox', { name: 'Rename folder' }))
    await user.type(screen.getByRole('textbox', { name: 'Rename folder' }), 'Review')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(useSessionFolders.getState().metadata.folders[0].name).toBe('Review')

    await user.click(screen.getByRole('button', { name: 'Options for Review' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete folder' }))
    expect(useSessionFolders.getState().metadata.folders).toEqual([])
    expect(useSessionFolders.getState().metadata.membership).toEqual({})
    expect(screen.getByRole('group', { name: 'Active' })).toBeTruthy()
    expect(JSON.stringify(mocks.state)).toBe(initialSessions)
    expect(mocks.open).not.toHaveBeenCalled()
    expect(recordedChanges()).toEqual(['folder.create', 'move', 'folder.rename', 'folder.delete'])
    await user.click(screen.getByRole('button', { name: 'Open session Session tab-a' }))
    expect(mocks.open).toHaveBeenCalledOnce()
  })

  it('restores metadata without activating a session or invoking workflow/runtime commands', () => {
    const saved = {
      version: 1,
      folders: [{ id: '00000000-0000-4000-8000-000000000001', name: 'Saved folder' }],
      membership: {}
    }
    localStorage.setItem(personalViewStorageKey(SESSION_FOLDERS_STORAGE_KEY), JSON.stringify(saved))
    renderSidebar()
    expect(useSessionFolders.getState().metadata).toEqual(saved)
    expect(screen.getByRole('group', { name: 'Saved folder' })).toBeTruthy()
    expect(mocks.open).not.toHaveBeenCalled()
    expect(mocks.runtime).not.toHaveBeenCalled()
  })

  it('collapses, hides and unhides groups, persisting the view on this device', async () => {
    const user = userEvent.setup()
    renderSidebar()
    const toggle = screen.getByRole('button', { name: 'Collapse Active' })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    await user.click(toggle)
    expect(screen.getByRole('button', { name: 'Expand Active' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open session Session tab-a' })).toBeNull()
    expect(
      JSON.parse(localStorage.getItem(personalViewStorageKey(SESSION_SIDEBAR_VIEW_STORAGE_KEY))!)
    ).toMatchObject({
      collapsed: [expect.stringContaining('workspace:')]
    })

    await user.click(screen.getByRole('button', { name: 'Expand all' }))
    expect(screen.getByRole('button', { name: 'Open session Session tab-a' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Collapse all' }))
    expect(screen.queryByRole('button', { name: 'Open session Session tab-a' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Options for Active' }))
    await user.click(screen.getByRole('menuitem', { name: 'Hide from sidebar' }))
    expect(screen.queryByRole('group', { name: 'Active' })).toBeNull()
    expect(screen.getByRole('group', { name: 'Saved Sessions' })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Show 1 hidden' }))
    const hiddenGroup = screen.getByRole('group', { name: 'Active' })
    expect(hiddenGroup.hasAttribute('data-session-group-hidden')).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Options for Active' }))
    await user.click(screen.getByRole('menuitem', { name: 'Show in sidebar' }))
    expect(
      screen.getByRole('group', { name: 'Active' }).hasAttribute('data-session-group-hidden')
    ).toBe(false)
    expect(
      JSON.parse(localStorage.getItem(personalViewStorageKey(SESSION_SIDEBAR_VIEW_STORAGE_KEY))!)
        .hidden
    ).toEqual([])
    expect(mocks.open).not.toHaveBeenCalled()
  })

  it('files a dragged session into a folder and reorders folder groups by drag', () => {
    localStorage.setItem(
      personalViewStorageKey(SESSION_FOLDERS_STORAGE_KEY),
      JSON.stringify({
        version: 1,
        folders: [
          { id: '00000000-0000-4000-8000-000000000001', name: 'Later' },
          { id: '00000000-0000-4000-8000-000000000002', name: 'Soon' }
        ],
        membership: {}
      })
    )
    renderSidebar()
    const row = screen.getByRole('button', { name: 'Open session Session tab-a' }).parentElement!
    expect(row.getAttribute('draggable')).toBe('true')
    const sessionKey = Object.keys(useSessionFolders.getState().metadata.membership)[0] ?? null
    expect(sessionKey).toBeNull()
    const rowTransfer = fakeDataTransfer(SESSION_ROW_DRAG_TYPE, '')
    fireDrag('dragStart', row, { dataTransfer: rowTransfer })
    const draggedKey = rowTransfer.setData.mock.calls[0]?.[1] as string
    expect(draggedKey).toContain('provider')
    // Why Expand: folders start folded.
    const later = within(screen.getByRole('group', { name: 'Later' })).getByRole('button', {
      name: 'Expand Later'
    }).parentElement!
    const dropTransfer = fakeDataTransfer(SESSION_ROW_DRAG_TYPE, draggedKey)
    fireDrag('dragOver', later, { dataTransfer: dropTransfer, clientY: 5 })
    expect(later.getAttribute('data-session-group-drop')).toBe('row')
    fireDrag('drop', later, { dataTransfer: dropTransfer, clientY: 5 })
    expect(useSessionFolders.getState().metadata.membership[draggedKey]).toBe(
      '00000000-0000-4000-8000-000000000001'
    )
    // Why no click: the drop unfolds the folder it landed in.
    expect(screen.getByRole('button', { name: 'Collapse Later' })).toBeTruthy()
    expect(
      within(screen.getByRole('group', { name: 'Later' })).getByRole('button', {
        name: 'Open session Session tab-a'
      })
    ).toBeTruthy()

    // Reorder the two (still-empty) folder groups by drag — user folders still reorder.
    const groups = () =>
      screen.getAllByRole('group').map((group) => group.getAttribute('aria-label'))
    expect(groups()).toEqual(['Later', 'Soon', 'Active', 'Saved Sessions'])
    const soonHeader = screen.getByRole('button', { name: 'Expand Soon' }).parentElement!
    const groupTransfer = fakeDataTransfer(SESSION_GROUP_DRAG_TYPE, '')
    fireDrag('dragStart', soonHeader, { dataTransfer: groupTransfer })
    const groupKey = groupTransfer.setData.mock.calls[0]?.[1] as string
    const laterHeader = screen.getByRole('button', { name: 'Collapse Later' }).parentElement!
    laterHeader.getBoundingClientRect = () => ({ top: 100, height: 20 }) as DOMRect
    const groupDrop = fakeDataTransfer(SESSION_GROUP_DRAG_TYPE, groupKey)
    fireDrag('dragOver', laterHeader, { dataTransfer: groupDrop, clientY: 102 })
    expect(laterHeader.getAttribute('data-session-group-drop')).toBe('before')
    fireDrag('drop', laterHeader, { dataTransfer: groupDrop, clientY: 102 })
    expect(groups()).toEqual(['Soon', 'Later', 'Active', 'Saved Sessions'])
    expect(
      JSON.parse(localStorage.getItem(personalViewStorageKey(SESSION_SIDEBAR_VIEW_STORAGE_KEY))!)
        .order[0]
    ).toBe(groupKey)
    expect(mocks.open).not.toHaveBeenCalled()
  })

  it('lets a custom folder move below Active and still accepts returning session drops', () => {
    localStorage.setItem(
      personalViewStorageKey(SESSION_FOLDERS_STORAGE_KEY),
      JSON.stringify({
        version: 1,
        folders: [{ id: '00000000-0000-4000-8000-000000000001', name: 'Later' }],
        membership: {}
      })
    )
    renderSidebar()
    // The one session starts unfiled, so it is already in the remainder group.
    const groups = () =>
      screen.getAllByRole('group').map((group) => group.getAttribute('aria-label'))
    expect(groups()).toEqual(['Later', 'Active', 'Saved Sessions'])
    const remainderHeader = screen.getByRole('button', {
      name: 'Collapse Active'
    }).parentElement!
    expect(remainderHeader.getAttribute('draggable')).toBe('true')
    const folderHeader = screen.getByRole('button', { name: 'Expand Later' }).parentElement!
    const groupTransfer = fakeDataTransfer(SESSION_GROUP_DRAG_TYPE, '')
    fireDrag('dragStart', folderHeader, { dataTransfer: groupTransfer })
    const groupKey = groupTransfer.setData.mock.calls[0]?.[1] as string
    remainderHeader.getBoundingClientRect = () => ({ top: 0, height: 20 }) as DOMRect
    const groupDrop = fakeDataTransfer(SESSION_GROUP_DRAG_TYPE, groupKey)
    fireDrag('dragOver', remainderHeader, { dataTransfer: groupDrop, clientY: 16 })
    expect(remainderHeader.getAttribute('data-session-group-drop')).toBe('after')
    fireDrag('drop', remainderHeader, { dataTransfer: groupDrop, clientY: 16 })
    expect(groups()).toEqual(['Active', 'Later', 'Saved Sessions'])
    expect(
      JSON.parse(localStorage.getItem(personalViewStorageKey(SESSION_SIDEBAR_VIEW_STORAGE_KEY))!)
        .order
    ).toEqual(['workspace:other', groupKey])

    // Dropping the row itself on this same remainder header still unfiles it (it
    // already lives there, so this is a no-op move, not a reorder) — the real
    // unfile-onto-the-remainder-group contract is covered where a filed row
    // exists to unfile, in session-sidebar-tree.test.ts.
    const row = screen.getByRole('button', { name: 'Open session Session tab-a' }).parentElement!
    const rowTransfer = fakeDataTransfer(SESSION_ROW_DRAG_TYPE, '')
    fireDrag('dragStart', row, { dataTransfer: rowTransfer })
    const draggedKey = rowTransfer.setData.mock.calls[0]?.[1] as string
    remainderHeader.getBoundingClientRect = () => ({ top: 0, height: 20 }) as DOMRect
    const rowDrop = fakeDataTransfer(SESSION_ROW_DRAG_TYPE, draggedKey)
    fireDrag('dragOver', remainderHeader, { dataTransfer: rowDrop, clientY: 5 })
    expect(remainderHeader.getAttribute('data-session-group-drop')).toBe('row')
    expect(mocks.open).not.toHaveBeenCalled()
  })

  it('pins a Needs you group and highlights the waiting row', () => {
    const source = sessionTestSource()
    const tab = addSessionTestTab(source)
    addSessionTestRecord(source, tab)
    mocks.state = {
      ...source,
      retainedAgentsByPaneKey: {},
      activeTabId: null,
      activeWorktreeId: null,
      getKnownWorktreeById: () => undefined
    }
    const paneKey = `${tab.id}:00000000-0000-4000-8000-000000000001`
    const pane = {
      paneKey,
      portalPaneKey: paneKey,
      worktreeId: SESSION_TEST_WORKTREE,
      tabId: tab.id,
      leafId: '00000000-0000-4000-8000-000000000001',
      agentType: 'codex',
      bucket: 'attention',
      dotState: 'waiting',
      cause: 'waiting',
      unseen: true,
      title: 'Session tab-a',
      stateChangedAt: 1,
      repoName: 'Project A',
      worktreeName: 'main'
    }
    mocks.snapshot = {
      ...EMPTY_AGENT_PANE_SNAPSHOT,
      cardsByPaneKey: new Map([[paneKey, pane]]),
      attentionByPaneKey: new Map([[paneKey, pane]])
    }
    renderSidebar()
    const needsYou = screen.getByRole('group', { name: 'Needs you' })
    const row = within(needsYou).getByRole('button', {
      name: 'Open session Session tab-a'
    }).parentElement!
    expect(row.hasAttribute('data-needs-attention')).toBe(true)
    // Why: a compact row keeps "Waiting for your input" for its hover card; at rest it shows the
    // needs-you mark and nothing else (SessionSidebarRow.test reads the line in comfortable rows).
    expect(within(needsYou).queryByText('Waiting for your input')).toBeNull()
    expect(
      row.querySelector('[data-session-row-indicator]')!.getAttribute('data-session-row-indicator')
    ).toBe('needs-you')
    // Why: the row is listed once — it left Active, so no group badge counts it there.
    expect(screen.queryByLabelText('1 need you')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Open session Session tab-a' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Options for Needs you' })).toBeNull()
  })

  // Why: a fresh pane used to be unfilable until the agent reported its provider
  // session, which meant a person could make a folder and then be refused by every
  // conversation in the list. The pane's own identity now carries the filing.
  it('lets a fresh pane be filed before its provider identity arrives', () => {
    const source = sessionTestSource()
    addSessionTestTab(source)
    mocks.state = {
      ...source,
      retainedAgentsByPaneKey: {},
      activeWorktreeId: null,
      getKnownWorktreeById: () => undefined
    }
    renderSidebar()
    expect(
      screen.queryByText('Folder assignment is available when the agent identifies this session.')
    ).toBeNull()
    expect(
      (screen.getByRole('button', { name: 'Archive Session tab-a' }) as HTMLButtonElement).disabled
    ).toBe(false)
    expect(
      (screen.getByRole('button', { name: 'Open session Session tab-a' }) as HTMLButtonElement)
        .disabled
    ).toBe(false)
  })

  // Why: the honest refusal still has to exist. Without a host there is no identity
  // that survives a restart, and a folder that silently empties is worse than one
  // that says it cannot take this yet.
  it('still explains itself when no identity can be formed at all', () => {
    const source = sessionTestSource()
    addSessionTestTab(source)
    // Why: an unresolvable workspace leaves the host unknown, which is the one case
    // that can produce no key of any kind.
    source.worktreesByRepo = {}
    source.folderWorkspaces = []
    mocks.state = {
      ...source,
      retainedAgentsByPaneKey: {},
      activeWorktreeId: null,
      getKnownWorktreeById: () => undefined
    }
    renderSidebar()
    // Why: the note waits in the row's details, so the list itself stays one line per row.
    expect(
      screen.queryByText('Folder assignment is available when the agent identifies this session.')
    ).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show details for Session tab-a' }))
    expect(
      screen.getByText('Folder assignment is available when the agent identifies this session.')
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Session tab-a' }))
    expect(
      (screen.getByRole('button', { name: 'Move to folder (0)' }) as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it('keeps one new-conversation control at the toolbar right, after folder and project creation', () => {
    const view = renderSidebar()
    const inToolbar = document.querySelector<HTMLButtonElement>('[data-new-conversation]')!
    expect(inToolbar.textContent).toBe('New conversation')
    // Why: + is also where a conversation is dropped to start a routine from it.
    const dropSlot = inToolbar.closest('[data-routine-drop-target]')!
    const newProject = screen.getByRole('button', { name: 'New project' })
    expect(newProject.previousElementSibling).toBe(
      screen.getByRole('button', { name: 'New folder' })
    )
    expect(dropSlot.previousElementSibling).toBe(newProject)
    expect(dropSlot.nextElementSibling).toBeNull()
    expect(inToolbar.closest('[role="group"]')).toBeNull()
    view.unmount()

    const paneKey = 'tab-a:00000000-0000-4000-8000-000000000001'
    // A dashboard turn ending is not whole-commitment completion.
    const finishedAt = Date.now() - 60 * 60_000
    mocks.snapshot = {
      ...EMPTY_AGENT_PANE_SNAPSHOT,
      cardsByPaneKey: new Map([
        [paneKey, { paneKey, bucket: 'done', dotState: 'done', stateChangedAt: finishedAt }]
      ])
    }
    renderSidebar()
    const starts = document.querySelectorAll('[data-new-conversation]')
    expect(starts).toHaveLength(1)
    expect(starts[0].closest('[role="group"]')).toBeNull()
    expect(starts[0].closest('[data-routine-drop-target]')!.previousElementSibling).toBe(
      screen.getByRole('button', { name: 'New project' })
    )
  })

  it('renames a conversation from the pencil on its name', async () => {
    const user = userEvent.setup()
    const setTabCustomTitle = vi.fn()
    mocks.state = { ...mocks.state, setTabCustomTitle }
    renderSidebar()
    await user.click(screen.getByRole('button', { name: 'Rename Session tab-a' }))
    await user.clear(screen.getByRole('textbox', { name: 'Rename Session tab-a' }))
    await user.keyboard('Launch plan{Enter}')
    const byPerson = { recordInteraction: true, origin: 'yours' }
    expect(setTabCustomTitle).toHaveBeenCalledExactlyOnceWith('tab-a', 'Launch plan', byPerson)
    expect(mocks.open).not.toHaveBeenCalled()
  })

  it('opens the Sessions view from the normal sidebar switch without launching work', async () => {
    const user = userEvent.setup()
    // Why: a fresh element per render — React skips a re-render of the identical element.
    const tree = () => (
      <TooltipProvider>
        <ConfirmationDialogProvider>
          <SidebarSessionSurface>
            <div>Workspace rows</div>
          </SidebarSessionSurface>
        </ConfirmationDialogProvider>
      </TooltipProvider>
    )
    // Why: the surface choice lives in the store now; the plain-object mock re-renders by hand.
    mocks.state = {
      ...mocks.state,
      sidebarSessionSurface: 'workspaces',
      setSidebarSessionSurface: (surface: string) => {
        mocks.state = { ...mocks.state, sidebarSessionSurface: surface }
        view.rerender(tree())
      }
    }
    const view = render(tree())
    expect(screen.getByText('Workspace rows')).toBeTruthy()
    await user.click(screen.getByRole('radio', { name: 'Conversations' }))
    expect(await screen.findByRole('region', { name: 'Sessions' })).toBeTruthy()
    expect(screen.queryByText('Workspace rows')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Developer Workspaces' }))
    expect(screen.getByText('Workspace rows')).toBeTruthy()
    await user.click(screen.getByRole('radio', { name: 'Conversations' }))
    expect(await screen.findByRole('region', { name: 'Sessions' })).toBeTruthy()
    expect(screen.queryByText('Workspace rows')).toBeNull()
    expect(mocks.open).not.toHaveBeenCalled()
    expect(recordedChanges()).toEqual([])
  })
})

it('creates a folder inside Saved Sessions, expands it and files a session without launching work', async () => {
  const user = userEvent.setup()
  mocks.snapshot = { ...EMPTY_AGENT_PANE_SNAPSHOT }
  renderSidebar()
  await user.click(screen.getByRole('button', { name: 'New saved sessions folder' }))
  await user.type(screen.getByRole('textbox', { name: 'New folder' }), 'Research archive')
  await user.keyboard('{Enter}')
  const folder = useSessionFolders
    .getState()
    .metadata.folders.find((entry) => entry.name === 'Research archive')!
  expect(folder.section).toBe('saved')
  expect(screen.getByRole('group', { name: 'Research archive' })).toBeTruthy()
  // Missing activity evidence keeps the session in Waiting until it can be verified.
  expect(screen.queryByRole('group', { name: /^Done/ })).toBeNull()
  await user.click(screen.getByRole('button', { name: /^Expand Waiting/ }))
  await user.click(screen.getByRole('checkbox', { name: 'Select Session tab-a' }))
  await user.click(screen.getByRole('button', { name: 'Move to folder (1)' }))
  await user.click(screen.getByRole('menuitem', { name: 'Research archive' }))
  // Why: a new folder starts folded like every other; opening it is remembered below.
  await user.click(screen.getByRole('button', { name: 'Expand Research archive' }))
  expect(
    within(screen.getByRole('group', { name: 'Research archive' })).getByRole('button', {
      name: 'Open session Session tab-a'
    })
  ).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'Collapse Saved Sessions' }))
  expect(screen.queryByRole('group', { name: 'Research archive' })).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Expand Saved Sessions' }))
  expect(
    within(screen.getByRole('group', { name: 'Research archive' })).getByRole('button', {
      name: 'Open session Session tab-a'
    })
  ).toBeTruthy()
  expect(mocks.open).not.toHaveBeenCalled()
  expect(recordedChanges()).toEqual(['folder.create', 'move'])
})
