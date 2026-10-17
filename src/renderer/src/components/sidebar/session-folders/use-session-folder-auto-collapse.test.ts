// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationRoutineGroup } from '@/lib/conversation-routine-rows'
import { SAVED_SESSIONS_FOLDER_ID, type SessionFolder } from '@/lib/session-folders'
import {
  emptySessionSidebarView,
  isSessionGroupCollapsed,
  sessionFolderGroupKey
} from '@/lib/session-sidebar-view'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { useSessionSelection } from '@/store/session-selection'
import { sessionGroupFocusIdleSince, useSessionGroupFocus } from '@/store/session-group-focus'
import type { SessionSidebarTreeRow } from '@/lib/session-sidebar-group-model'
import {
  fileDroppedSession,
  openSessionGroupsForDrag,
  unfoldSessionDropDestination,
  useSessionFolderAutoCollapse
} from './use-session-folder-auto-collapse'

const sales = '00000000-0000-4000-8000-000000000001'
const leads = '00000000-0000-4000-8000-000000000002'
const other = '00000000-0000-4000-8000-000000000003'
const folders: SessionFolder[] = [
  { id: sales, name: 'Sales', section: 'saved' },
  { id: leads, name: 'Leads', section: 'saved', parentId: sales },
  { id: other, name: 'Other', section: 'saved' }
]
const keys = [
  SAVED_SESSIONS_FOLDER_ID,
  ...folders.map((folder) => sessionFolderGroupKey(folder.id))
]

function groupsFromView(): ConversationRoutineGroup[] {
  const { view } = useSessionSidebarView.getState()
  return keys.map((key) => ({
    key,
    kind: key === SAVED_SESSIONS_FOLDER_ID ? 'saved' : 'folder',
    collapsed: isSessionGroupCollapsed(view, key),
    attentionCount: 0,
    rows: []
  })) as unknown as ConversationRoutineGroup[]
}

beforeEach(() => {
  useSessionSidebarView.setState({ view: emptySessionSidebarView() })
  useSessionSelection.getState().set([])
  useSessionGroupFocus.getState().reset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('bulk selection during the idle fold', () => {
  const row = (key: string) =>
    ({ session: { sessionKey: key, rowKey: key } }) as SessionSidebarTreeRow
  const group = (key: string, rowKeys: string[]) =>
    ({
      key,
      kind: 'workspace',
      collapsed: false,
      attentionCount: 0,
      rows: rowKeys.map(row)
    }) as ConversationRoutineGroup

  it('holds every selected status group open, then restarts the idle wait on clear', () => {
    vi.useFakeTimers()
    useSessionSelection.getState().set(['a', 'b'])
    const onCollapse = vi.fn()
    renderHook(() =>
      useSessionFolderAutoCollapse({
        groups: [group('waiting', ['a']), group('completed', ['b']), group('other', ['c'])],
        metadata: { version: 1, folders: [], membership: {} },
        currentKeys: [],
        seconds: 5,
        listRef: { current: null },
        onCollapse
      })
    )
    act(() => vi.advanceTimersByTime(7_000))
    expect(onCollapse.mock.calls.flatMap(([keys]) => keys)).toEqual(['other'])
    onCollapse.mockClear()
    act(() => {
      useSessionSelection.getState().set([])
      vi.advanceTimersByTime(4_000)
    })
    expect(onCollapse).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1_000))
    expect(onCollapse).toHaveBeenCalledWith(expect.arrayContaining(['waiting', 'completed']))
  })

  it('does not trim a selected group to its open conversation while the pointer is on the bar', () => {
    vi.useFakeTimers()
    useSessionSelection.getState().set(['a', 'b'])
    renderHook(() =>
      useSessionFolderAutoCollapse({
        groups: [group('waiting', ['a', 'b', 'c'])],
        metadata: { version: 1, folders: [], membership: {} },
        currentKeys: ['a'],
        seconds: 5,
        listRef: { current: null },
        onCollapse: vi.fn()
      })
    )
    act(() => vi.advanceTimersByTime(20_000))
    expect(useSessionGroupFocus.getState().trimmed.size).toBe(0)
    expect(sessionGroupFocusIdleSince.has('waiting')).toBe(true)
    act(() => {
      useSessionSelection.getState().set([])
      vi.advanceTimersByTime(5_000)
    })
    expect(useSessionGroupFocus.getState().trimmed.has('waiting')).toBe(true)
  })
})

describe('unfolding where a session was dropped', () => {
  it('opens the destination folder, every folder above it, and Saved Sessions', () => {
    unfoldSessionDropDestination(folders, leads)
    const { view } = useSessionSidebarView.getState()
    expect(keys.filter((key) => !isSessionGroupCollapsed(view, key))).toEqual([
      SAVED_SESSIONS_FOLDER_ID,
      sessionFolderGroupKey(sales),
      sessionFolderGroupKey(leads)
    ])
  })

  it('files a single dropped session and unfolds the folders it landed in', () => {
    useSessionFolders.setState({
      metadata: { version: 1, folders, membership: {} },
      loaded: true,
      error: null
    })
    fileDroppedSession('session-1', leads)
    expect(useSessionFolders.getState().metadata.membership['session-1']).toBe(leads)
    const { view } = useSessionSidebarView.getState()
    expect(isSessionGroupCollapsed(view, sessionFolderGroupKey(leads))).toBe(false)
    expect(isSessionGroupCollapsed(view, sessionFolderGroupKey(sales))).toBe(false)
    expect(isSessionGroupCollapsed(view, SAVED_SESSIONS_FOLDER_ID)).toBe(false)
  })

  it('holds the drop destination open while a folder a drag passed through folds', () => {
    vi.useFakeTimers()
    openSessionGroupsForDrag([sessionFolderGroupKey(other)])
    unfoldSessionDropDestination(folders, leads)
    const onCollapse = vi.fn()
    renderHook(() =>
      useSessionFolderAutoCollapse({
        groups: groupsFromView(),
        metadata: { version: 1, folders, membership: {} },
        currentKeys: [],
        seconds: 5,
        listRef: { current: null },
        onCollapse
      })
    )
    act(() => {
      vi.advanceTimersByTime(7_000)
    })
    expect(onCollapse).toHaveBeenCalledWith([sessionFolderGroupKey(other)])
    expect(onCollapse).toHaveBeenCalledTimes(1)
  })
})
