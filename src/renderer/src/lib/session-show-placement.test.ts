// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionGrid } from '@/store/session-grid'
import type { SessionGridPaneContent } from './session-grid-panes'
import type { SidebarSession } from './sidebar-sessions'

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))
const gridActions = vi.hoisted(() => ({
  workspaceGroupGridContent: vi.fn(),
  resumeSessionInGrid: vi.fn()
}))
const openSessionGrid = vi.hoisted(() => vi.fn())

vi.mock('@/store', () => ({ useAppStore: { getState: () => store.state } }))
vi.mock('./session-grid-actions', () => gridActions)
vi.mock('./session-grid-open', () => ({ openSessionGrid }))
vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: (storage: Storage, key: string) => storage.getItem(key)
}))

const { isTypingUnsentText, leastRecentGridPane, placeBesideInGrid, placeBesideInWorkspace } =
  await import('./session-show-placement')

const initialGrid = useSessionGrid.getState()

function session(key: string, worktreeId = 'wt-1'): SidebarSession {
  return {
    rowKey: `row-${key}`,
    sessionKey: key,
    worktreeId,
    hostId: 'local',
    tabId: `term-${key}`,
    paneKey: null,
    kind: 'terminal',
    label: key,
    workspaceLabel: worktreeId,
    agent: 'claude',
    unavailable: false,
    folderKeyMigration: null
  }
}

function gridContent(key: string, worktreeId = 'wt-1'): SessionGridPaneContent {
  return {
    kind: 'session',
    worktreeId,
    tabId: `term-${key}`,
    paneKey: null,
    sessionKey: key,
    label: key
  }
}

function shownLabels(): string[] {
  const { layout, panes } = useSessionGrid.getState()
  return layout.tracks.flat().map((id) => {
    const pane = panes[id]!
    return pane.kind === 'session' ? pane.label : pane.kind
  })
}

/** Workspace wt-1: group g-left shows `current`, group g-other holds `target` behind `front`. */
function workspace(overrides: Record<string, unknown> = {}): ReturnType<typeof vi.fn> {
  const dropUnifiedTab = vi.fn(() => true)
  store.state = {
    activeView: 'terminal',
    activeWorktreeId: 'wt-1',
    activeGroupIdByWorktree: { 'wt-1': 'g-left' },
    groupsByWorktree: {
      'wt-1': [
        { id: 'g-left', activeTabId: 'u-current', tabOrder: ['u-current'] },
        { id: 'g-other', activeTabId: 'u-front', tabOrder: ['u-front', 'u-target'] }
      ]
    },
    unifiedTabsByWorktree: {
      'wt-1': [
        { id: 'u-current', entityId: 'term-current', groupId: 'g-left', contentType: 'terminal' },
        { id: 'u-front', entityId: 'term-front', groupId: 'g-other', contentType: 'terminal' },
        { id: 'u-target', entityId: 'term-target', groupId: 'g-other', contentType: 'terminal' }
      ]
    },
    dropUnifiedTab,
    ...overrides
  }
  return dropUnifiedTab
}

beforeEach(() => {
  vi.clearAllMocks()
  useSessionGrid.getState().cancelPendingWrites()
  localStorage.clear()
  localStorage.setItem('omni.session-grid.v1', JSON.stringify(initialGrid))
  store.state = {}
  useSessionGrid.setState({ ...initialGrid, recentPaneIds: [] }, true)
  useSessionGrid.getState().load()
})

afterEach(() => useSessionGrid.getState().cancelPendingWrites())

describe('placeBesideInWorkspace', () => {
  it('splits a same-workspace conversation to the right of the focused split', () => {
    const drop = workspace()
    expect(placeBesideInWorkspace(session('target'))).toBe('split')
    expect(drop).toHaveBeenCalledWith('u-target', { groupId: 'g-left', splitDirection: 'right' })
  })

  it('leaves a conversation already in front of a split where it is', () => {
    const drop = workspace()
    expect(placeBesideInWorkspace(session('front'))).toBe('already-shown')
    expect(drop).not.toHaveBeenCalled()
  })

  it('hands a conversation from another workspace to the Grid', () => {
    const drop = workspace()
    expect(placeBesideInWorkspace(session('elsewhere', 'wt-2'))).toBeNull()
    expect(drop).not.toHaveBeenCalled()
  })

  it('falls back when the split cannot be made', () => {
    workspace({ dropUnifiedTab: vi.fn(() => false) })
    expect(placeBesideInWorkspace(session('target'))).toBeNull()
  })
})

describe('placeBesideInGrid', () => {
  it('opens the Grid with the current view on the left and the target on the right', () => {
    workspace()
    gridActions.workspaceGroupGridContent.mockReturnValue(gridContent('current'))
    expect(placeBesideInGrid(session('elsewhere', 'wt-2'))).toBe('grid')
    expect(gridActions.workspaceGroupGridContent).toHaveBeenCalledWith('wt-1', 'g-left')
    expect(shownLabels()).toEqual(['current', 'elsewhere'])
    expect(openSessionGrid).toHaveBeenCalled()
  })

  it('gives up the least recently used pane of a full Grid, never the current one', () => {
    for (const key of ['current', 'a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      useSessionGrid.getState().addPane(gridContent(key))
    }
    // Focus order, oldest first: b, then current, then the rest; b is the least recent.
    const idOf = (label: string): string =>
      Object.values(useSessionGrid.getState().panes).find(
        (pane) => pane.kind === 'session' && pane.label === label
      )!.id
    for (const label of ['b', 'current', 'a', 'c', 'd', 'e', 'f', 'g']) {
      useSessionGrid.getState().focusPane(idOf(label))
    }
    useSessionGrid.getState().focusPane(idOf('current'))
    store.state = { activeView: 'grid' }
    expect(placeBesideInGrid(session('new', 'wt-2'))).toBe('grid-replaced')
    expect(shownLabels()).toHaveLength(8)
    expect(shownLabels()).toContain('current')
    expect(shownLabels()).toContain('new')
    expect(shownLabels()).not.toContain('b')
  })

  it.each([
    ['grid', false],
    ['grid', true],
    ['attention', true]
  ])('reports a conversation already shown in %s (commandCenter=%s)', (view, commandCenter) => {
    store.state = { activeView: view, settings: { commandCenter } }
    useSessionGrid.getState().load(commandCenter)
    useSessionGrid.getState().addPane(gridContent('there', 'wt-2'))
    expect(placeBesideInGrid(session('there', 'wt-2'))).toBe('already-shown')
    expect(shownLabels()).toEqual(['there'])
  })

  it('opens a conversation with no tab yet and comes back to the Grid', () => {
    workspace()
    gridActions.workspaceGroupGridContent.mockReturnValue(gridContent('current'))
    const closed = { ...session('closed', 'wt-2'), tabId: null }
    placeBesideInGrid(closed)
    expect(gridActions.resumeSessionInGrid).toHaveBeenCalledWith(closed)
  })
})

describe('leastRecentGridPane', () => {
  it('picks the pane focused longest ago, never-focused first, skipping kept panes', () => {
    expect(leastRecentGridPane(['a', 'b', 'c'], ['a', 'b', 'c'], new Set())).toBe('c')
    expect(leastRecentGridPane(['a', 'b', 'c'], ['c', 'a'], new Set())).toBe('b')
    expect(leastRecentGridPane(['a', 'b'], ['a', 'b'], new Set(['b']))).toBe('a')
    expect(leastRecentGridPane(['a'], [], new Set(['a']))).toBeNull()
  })
})

describe('isTypingUnsentText', () => {
  it('is true only for an editable field holding unsent text', () => {
    const composer = document.createElement('textarea')
    expect(isTypingUnsentText(composer)).toBe(false)
    composer.value = 'half a sentence'
    expect(isTypingUnsentText(composer)).toBe(true)
    const xterm = document.createElement('textarea')
    xterm.className = 'xterm-helper-textarea'
    xterm.value = 'x'
    expect(isTypingUnsentText(xterm)).toBe(false)
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    expect(isTypingUnsentText(checkbox)).toBe(false)
    expect(isTypingUnsentText(document.body)).toBe(false)
  })
})
