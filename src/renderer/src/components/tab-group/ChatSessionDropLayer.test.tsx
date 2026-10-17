// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SESSION_ROW_DRAG_TYPE,
  beginSessionSidebarDrag,
  clearSessionSidebarDrag
} from '../../lib/session-sidebar-drag'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const dropUnifiedTab = vi.fn()
const activateSidebarSession = vi.fn()
const splitWorkspaceIntoSessionGrid = vi.fn()
const openSidebarSession = vi.fn()

const sessions = vi.hoisted(() => ({ list: [] as unknown[] }))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ dropUnifiedTab })
  }
}))

vi.mock('@/lib/activate-sidebar-session', () => ({
  activateSidebarSession: (...args: unknown[]) => activateSidebarSession(...args)
}))

vi.mock('@/lib/session-grid-actions', () => ({
  splitWorkspaceIntoSessionGrid: (...args: unknown[]) => splitWorkspaceIntoSessionGrid(...args)
}))

vi.mock('@/lib/open-sidebar-session', () => ({
  openSidebarSession: (...args: unknown[]) => openSidebarSession(...args)
}))

vi.mock('@/lib/sidebar-sessions', () => ({
  buildSidebarSessions: () => sessions.list
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

let ChatSessionDropLayer: React.ComponentType<{ worktreeId: string; enabled: boolean }>
let root: Root | null = null
let container: HTMLElement | null = null

const WORKTREE_ID = 'wt-1'

function makeRowDataTransfer(): DataTransfer {
  return {
    types: [SESSION_ROW_DRAG_TYPE],
    getData: () => '',
    setData: () => {},
    dropEffect: 'none'
  } as unknown as DataTransfer
}

function mountPane(groupId: string, rect: Partial<DOMRect>): HTMLElement {
  const pane = document.createElement('div')
  pane.dataset.tabGroupBodyId = groupId
  pane.dataset.worktreeId = WORKTREE_ID
  pane.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: 400,
      height: 300,
      right: 400,
      bottom: 300,
      x: 0,
      y: 0,
      toJSON: () => ({}),
      ...rect
    }) as DOMRect
  document.body.appendChild(pane)
  return pane
}

function dispatchDrop(target: HTMLElement, point: { x: number; y: number }): void {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: makeRowDataTransfer() })
  Object.defineProperty(event, 'clientX', { value: point.x })
  Object.defineProperty(event, 'clientY', { value: point.y })
  target.dispatchEvent(event)
}

describe('ChatSessionDropLayer', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    sessions.list = []
    container = document.createElement('div')
    container.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 400,
        height: 300,
        right: 400,
        bottom: 300,
        x: 0,
        y: 0,
        toJSON: () => ({})
      }) as DOMRect
    document.body.appendChild(container)
    ChatSessionDropLayer = (await import('./ChatSessionDropLayer')).default
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = null
    document.body.innerHTML = ''
    clearSessionSidebarDrag()
  })

  function mount(): void {
    root = createRoot(container!)
    act(() => {
      root!.render(<ChatSessionDropLayer worktreeId={WORKTREE_ID} enabled />)
    })
  }

  it('puts a session dropped on a side into the Grid beside that split', () => {
    sessions.list = [
      { sessionKey: 'session-a', worktreeId: WORKTREE_ID, tabId: 'tab-a', unavailable: false }
    ]
    mountPane('group-1', {})
    beginSessionSidebarDrag({
      kind: 'row',
      sessionKey: 'session-a',
      workspaceGroupKey: 'ws-1'
    })
    mount()
    // Drop near the left edge (30% band) -> the left side.
    dispatchDrop(document.body, { x: 10, y: 150 })

    expect(splitWorkspaceIntoSessionGrid).toHaveBeenCalledTimes(1)
    expect(splitWorkspaceIntoSessionGrid).toHaveBeenCalledWith({
      worktreeId: WORKTREE_ID,
      groupId: 'group-1',
      zone: 'left',
      sessionKeys: ['session-a']
    })
    expect(dropUnifiedTab).not.toHaveBeenCalled()
    expect(activateSidebarSession).not.toHaveBeenCalled()
  })

  it('carries the whole selection when a selected row is dropped on a side', () => {
    mountPane('group-1', {})
    beginSessionSidebarDrag({
      kind: 'row',
      sessionKey: 'session-a',
      workspaceGroupKey: 'ws-1',
      batch: { sessionKeys: ['session-a', 'session-b'], folderIds: [], blockedFolderIds: [] }
    })
    mount()
    dispatchDrop(document.body, { x: 390, y: 150 })

    expect(splitWorkspaceIntoSessionGrid).toHaveBeenCalledWith(
      expect.objectContaining({ zone: 'right', sessionKeys: ['session-a', 'session-b'] })
    )
  })

  it('drops into the center band without a splitDirection', () => {
    sessions.list = [
      { sessionKey: 'session-a', worktreeId: WORKTREE_ID, tabId: 'tab-a', unavailable: false }
    ]
    mountPane('group-1', {})
    beginSessionSidebarDrag({ kind: 'row', sessionKey: 'session-a', workspaceGroupKey: 'ws-1' })
    mount()
    dispatchDrop(document.body, { x: 200, y: 150 })

    expect(dropUnifiedTab).toHaveBeenCalledWith('tab-a', { groupId: 'group-1' })
  })

  it('activates a not-yet-open session dropped in the middle before relocating its tab', async () => {
    sessions.list = [
      { sessionKey: 'session-b', worktreeId: WORKTREE_ID, tabId: null, unavailable: false }
    ]
    activateSidebarSession.mockImplementation(async () => {
      sessions.list = [
        { sessionKey: 'session-b', worktreeId: WORKTREE_ID, tabId: 'tab-new', unavailable: false }
      ]
      return { handled: 'opened' }
    })
    mountPane('group-1', {})
    beginSessionSidebarDrag({ kind: 'row', sessionKey: 'session-b', workspaceGroupKey: 'ws-1' })
    mount()
    dispatchDrop(document.body, { x: 200, y: 150 })

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(activateSidebarSession).toHaveBeenCalledTimes(1)
    expect(dropUnifiedTab).toHaveBeenCalledWith('tab-new', { groupId: 'group-1' })
  })

  it('opens a session from another workspace dropped in the middle where it lives', () => {
    const other = {
      sessionKey: 'session-c',
      worktreeId: 'wt-2',
      tabId: 'tab-c',
      unavailable: false
    }
    sessions.list = [other]
    mountPane('group-1', {})
    beginSessionSidebarDrag({ kind: 'row', sessionKey: 'session-c', workspaceGroupKey: 'ws-2' })
    mount()
    dispatchDrop(document.body, { x: 200, y: 150 })

    expect(openSidebarSession).toHaveBeenCalledWith(other)
    expect(dropUnifiedTab).not.toHaveBeenCalled()
  })

  it('never spawns a duplicate for an already-open session even when dropped repeatedly', () => {
    sessions.list = [
      { sessionKey: 'session-a', worktreeId: WORKTREE_ID, tabId: 'tab-a', unavailable: false }
    ]
    mountPane('group-1', {})
    mount()

    beginSessionSidebarDrag({ kind: 'row', sessionKey: 'session-a', workspaceGroupKey: 'ws-1' })
    dispatchDrop(document.body, { x: 200, y: 150 })
    beginSessionSidebarDrag({ kind: 'row', sessionKey: 'session-a', workspaceGroupKey: 'ws-1' })
    dispatchDrop(document.body, { x: 200, y: 150 })

    expect(activateSidebarSession).not.toHaveBeenCalled()
    expect(dropUnifiedTab).toHaveBeenCalledTimes(2)
  })

  it('ignores drags that are not a session row (e.g. a folder-group drag)', () => {
    sessions.list = [
      { sessionKey: 'session-a', worktreeId: WORKTREE_ID, tabId: 'tab-a', unavailable: false }
    ]
    mountPane('group-1', {})
    mount()
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: ['application/x-omni-session-group'], getData: () => '', setData: () => {} }
    })
    Object.defineProperty(event, 'clientX', { value: 10 })
    Object.defineProperty(event, 'clientY', { value: 150 })
    document.body.dispatchEvent(event)

    expect(dropUnifiedTab).not.toHaveBeenCalled()
    expect(activateSidebarSession).not.toHaveBeenCalled()
    expect(splitWorkspaceIntoSessionGrid).not.toHaveBeenCalled()
  })
})
