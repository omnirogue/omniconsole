// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SAVED_SESSIONS_FOLDER_ID, type SessionFolder } from '@/lib/session-folders'
import {
  beginSessionSidebarDrag,
  clearSessionSidebarDrag,
  SESSION_ROW_DRAG_TYPE
} from '@/lib/session-sidebar-drag'
import {
  emptySessionSidebarView,
  isSessionGroupCollapsed,
  sessionFolderGroupKey
} from '@/lib/session-sidebar-view'
import type { SessionSidebarGroup } from '@/lib/session-sidebar-tree'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { useSessionGroupDrop } from './use-session-group-drop'

const leads = '00000000-0000-4000-8000-000000000002'
const folder: SessionFolder = { id: leads, name: 'Leads', section: 'saved' }

function dragOver(): React.DragEvent<HTMLDivElement> {
  return {
    dataTransfer: { types: [SESSION_ROW_DRAG_TYPE], dropEffect: 'none' },
    clientY: 10,
    currentTarget: { dataset: {}, getBoundingClientRect: () => ({ top: 0, height: 20 }) },
    preventDefault: () => {}
  } as unknown as React.DragEvent<HTMLDivElement>
}

function renderDrop(group: Pick<SessionSidebarGroup, 'key' | 'kind' | 'folder'>) {
  return renderHook(() =>
    useSessionGroupDrop({
      group: { ...group, canReorder: false, collapsed: true },
      folders: [folder],
      onMoveGroup: vi.fn(),
      onMoveSessionKey: vi.fn()
    })
  )
}

const isOpen = (key: string) => !isSessionGroupCollapsed(useSessionSidebarView.getState().view, key)

beforeEach(() => {
  vi.useFakeTimers()
  useSessionSidebarView.setState({ view: emptySessionSidebarView() })
  beginSessionSidebarDrag({ kind: 'row', sessionKey: 'session-1', workspaceGroupKey: '' })
})

afterEach(() => {
  clearSessionSidebarDrag()
  vi.useRealTimers()
})

describe('a drag resting on a folded group', () => {
  it('opens a folded folder after about 600 ms, not before', () => {
    const key = sessionFolderGroupKey(leads)
    const { result } = renderDrop({ key, kind: 'folder', folder })
    act(() => result.current.handleDragOver(dragOver()))
    act(() => vi.advanceTimersByTime(500))
    act(() => result.current.handleDragOver(dragOver()))
    expect(isOpen(key)).toBe(false)
    act(() => vi.advanceTimersByTime(100))
    expect(isOpen(key)).toBe(true)
  })

  it('opens folded Saved Sessions the same way', () => {
    const { result } = renderDrop({ key: SAVED_SESSIONS_FOLDER_ID, kind: 'saved' })
    act(() => result.current.handleDragOver(dragOver()))
    act(() => vi.advanceTimersByTime(600))
    expect(isOpen(SAVED_SESSIONS_FOLDER_ID)).toBe(true)
  })

  it('does not open when the drag moves on first', () => {
    const key = sessionFolderGroupKey(leads)
    const { result } = renderDrop({ key, kind: 'folder', folder })
    act(() => result.current.handleDragOver(dragOver()))
    act(() =>
      result.current.handleDragLeave({
        currentTarget: { contains: () => false },
        relatedTarget: null
      } as unknown as React.DragEvent<HTMLDivElement>)
    )
    act(() => vi.advanceTimersByTime(1_000))
    expect(isOpen(key)).toBe(false)
  })
})
