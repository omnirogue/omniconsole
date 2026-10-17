import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionGridPaneContent } from '@/lib/session-grid-panes'
import { useSessionGrid } from './session-grid'

vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))

const initial = useSessionGrid.getState()

const session = (key: string): SessionGridPaneContent => ({
  kind: 'session',
  worktreeId: `wt-${key}`,
  tabId: `tab-${key}`,
  paneKey: `pane-${key}`,
  sessionKey: key,
  label: key
})

function shownLabels(): string[] {
  const { layout, panes } = useSessionGrid.getState()
  return layout.tracks.flat().map((id) => {
    const pane = panes[id]!
    return pane.kind === 'session' ? pane.label : pane.kind
  })
}

describe('the session grid store', () => {
  beforeEach(() => {
    useSessionGrid.setState(initial, true)
    useSessionGrid.getState().load()
  })

  it('shows a conversation once, focusing it when it is added again', () => {
    const first = useSessionGrid.getState().addPane(session('a'))
    useSessionGrid.getState().addPane(session('b'))
    const again = useSessionGrid.getState().addPane(session('a'))
    expect(again).toEqual({ status: 'shown', paneId: first.paneId })
    expect(shownLabels()).toEqual(['a', 'b'])
    expect(useSessionGrid.getState().focusedPaneId).toBe(first.paneId)
  })

  it('holds eight panes and refuses a ninth', () => {
    for (const key of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      expect(useSessionGrid.getState().addPane(session(key)).status).toBe('added')
    }
    expect(useSessionGrid.getState().addPane(session('i'))).toEqual({
      status: 'full',
      paneId: null
    })
    expect(shownLabels()).toHaveLength(8)
  })

  it('minimizes a pane into the tray and brings it back', () => {
    const { paneId } = useSessionGrid.getState().addPane(session('a'))
    useSessionGrid.getState().addPane(session('b'))
    useSessionGrid.getState().minimizePane(paneId!)
    expect(shownLabels()).toEqual(['b'])
    expect(useSessionGrid.getState().minimized).toEqual([paneId])
    useSessionGrid.getState().restorePane(paneId!)
    expect(shownLabels().sort()).toEqual(['a', 'b'])
    expect(useSessionGrid.getState().minimized).toEqual([])
  })

  it('forgets a closed pane and its notepad', () => {
    const { paneId } = useSessionGrid.getState().addPane({ kind: 'notepad', noteId: 'n1' })
    useSessionGrid.getState().setNote('n1', { text: 'remember' })
    useSessionGrid.getState().removePane(paneId!)
    expect(useSessionGrid.getState().panes).toEqual({})
    expect(useSessionGrid.getState().notes).toEqual({})
  })

  it('starts a new grid from a workspace drop and keeps the old one in the tray', () => {
    useSessionGrid.getState().addPane(session('old-1'))
    useSessionGrid.getState().addPane(session('old-2'))
    const result = useSessionGrid
      .getState()
      .splitFromWorkspace(session('current'), session('dropped'), 'right')
    expect(result.status).toBe('added')
    expect(useSessionGrid.getState().layout.tracks.map((track) => track.length)).toEqual([1, 1])
    expect(shownLabels()).toEqual(['current', 'dropped'])
    expect(useSessionGrid.getState().minimized).toHaveLength(2)
  })

  it('grows the grid when the conversation on screen is already in it', () => {
    useSessionGrid.getState().addPane(session('current'))
    useSessionGrid.getState().addPane(session('other'))
    useSessionGrid.getState().splitFromWorkspace(session('current'), session('dropped'), 'bottom')
    expect(useSessionGrid.getState().layout.tracks).toHaveLength(2)
    expect(shownLabels()).toEqual(['current', 'dropped', 'other'])
    expect(useSessionGrid.getState().minimized).toEqual([])
  })

  it('replaces a pane in place', () => {
    const { paneId } = useSessionGrid.getState().addPane(session('a'))
    useSessionGrid.getState().addPane(session('b'))
    useSessionGrid.getState().replacePane(paneId!, session('c'))
    expect(shownLabels()).toEqual(['c', 'b'])
  })
})
