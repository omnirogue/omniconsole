import { describe, expect, it } from 'vitest'
import { SAVED_SESSIONS_FOLDER_ID } from './session-folders'
import {
  opensOnDragHover,
  readSessionSidebarDrag,
  readSessionSidebarDragKind,
  resolveGroupDropPosition,
  resolveSessionGroupDrop,
  SESSION_GROUP_DRAG_TYPE,
  SESSION_ROW_DRAG_TYPE,
  writeSessionSidebarDrag
} from './session-sidebar-drag'

function fakeDataTransfer() {
  const values = new Map<string, string>()
  return {
    values,
    types: [] as string[],
    setData(type: string, value: string) {
      values.set(type, value)
      this.types = [...values.keys()]
    },
    getData(type: string) {
      return values.get(type) ?? ''
    }
  }
}

describe('session sidebar drag payloads', () => {
  it('round-trips row and group payloads through the data transfer', () => {
    const row = fakeDataTransfer()
    writeSessionSidebarDrag(row, { kind: 'row', sessionKey: 'session-1' })
    expect(row.types).toEqual([SESSION_ROW_DRAG_TYPE])
    expect(readSessionSidebarDrag(row)).toEqual({ kind: 'row', sessionKey: 'session-1' })

    const group = fakeDataTransfer()
    writeSessionSidebarDrag(group, { kind: 'group', groupKey: 'folder:a' })
    expect(readSessionSidebarDragKind(group.types)).toBe('group')
    expect(readSessionSidebarDrag(group)).toEqual({ kind: 'group', groupKey: 'folder:a' })
    expect(readSessionSidebarDrag(fakeDataTransfer())).toBeNull()
    expect(readSessionSidebarDragKind(['text/plain'])).toBeNull()
    expect(readSessionSidebarDragKind([SESSION_GROUP_DRAG_TYPE])).toBe('group')
  })

  it('splits a header at its vertical middle', () => {
    expect(resolveGroupDropPosition(104, { top: 100, height: 20 })).toBe('before')
    expect(resolveGroupDropPosition(116, { top: 100, height: 20 })).toBe('after')
  })
})

describe('resolveSessionGroupDrop', () => {
  const rect = { top: 0, height: 20 }
  const folder = { key: 'folder:a', kind: 'folder' as const, folderId: 'a', canReorder: true }
  const workspace = {
    key: 'workspace:local:w1',
    kind: 'workspace' as const,
    folderId: null,
    canReorder: true
  }
  const attention = {
    key: 'attention',
    kind: 'attention' as const,
    folderId: null,
    canReorder: false
  }

  it('files a dragged session into a folder or back into its own workspace only', () => {
    const drag = { kind: 'row' as const, sessionKey: 's1', workspaceGroupKey: 'workspace:local:w1' }
    expect(resolveSessionGroupDrop({ drag, group: folder, clientY: 5, rect })).toEqual({
      kind: 'row',
      folderId: 'a'
    })
    expect(resolveSessionGroupDrop({ drag, group: workspace, clientY: 5, rect })).toEqual({
      kind: 'row',
      folderId: null
    })
    expect(
      resolveSessionGroupDrop({
        drag,
        group: { ...workspace, key: 'workspace:local:w2' },
        clientY: 5,
        rect
      })
    ).toBeNull()
    expect(
      resolveSessionGroupDrop({
        drag,
        group: { ...workspace, key: 'workspace:other' },
        clientY: 5,
        rect
      })
    ).toEqual({ kind: 'row', folderId: null })
    expect(resolveSessionGroupDrop({ drag, group: attention, clientY: 5, rect })).toBeNull()
  })

  it("rejects every drop on a paired owner's read-only folder (graft 2)", () => {
    const ownerFolder = { ...folder, readOnlyOwnerFolder: true as const }
    const row = { kind: 'row' as const, sessionKey: 's1', workspaceGroupKey: 'workspace:local:w1' }
    expect(resolveSessionGroupDrop({ drag: row, group: ownerFolder, clientY: 5, rect })).toBeNull()
    expect(
      resolveSessionGroupDrop({
        drag: { kind: 'group', groupKey: 'folder:b' },
        group: ownerFolder,
        clientY: 10,
        rect,
        zone: 'body'
      })
    ).toBeNull()
  })

  it('reorders groups by pointer side and refuses self drops and pinned groups', () => {
    const drag = { kind: 'group' as const, groupKey: 'folder:b' }
    expect(resolveSessionGroupDrop({ drag, group: folder, clientY: 4, rect })).toEqual({
      kind: 'group',
      position: 'before'
    })
    expect(resolveSessionGroupDrop({ drag, group: folder, clientY: 16, rect })).toEqual({
      kind: 'group',
      position: 'after'
    })
    expect(
      resolveSessionGroupDrop({
        drag: { kind: 'group', groupKey: 'folder:a' },
        group: folder,
        clientY: 4,
        rect
      })
    ).toBeNull()
    expect(resolveSessionGroupDrop({ drag, group: attention, clientY: 4, rect })).toBeNull()
    expect(resolveSessionGroupDrop({ drag: null, group: folder, clientY: 4, rect })).toBeNull()
  })

  it.each(['completed', 'waiting', 'stopped'] as const)(
    'returns a filed session to automatic grouping when dropped on %s',
    (kind) => {
      expect(
        resolveSessionGroupDrop({
          drag: { kind: 'row', sessionKey: 'filed', workspaceGroupKey: 'workspace:other' },
          group: { key: kind, kind, folderId: null, canReorder: true },
          clientY: 5,
          rect
        })
      ).toEqual({ kind: 'row', folderId: null })
    }
  )
})

describe('opening a folded group under a drag', () => {
  const into = { kind: 'row', folderId: 'folder-1' } as const

  it('opens a folded folder or folded Saved Sessions the drag can go into', () => {
    expect(opensOnDragHover({ kind: 'folder', collapsed: true }, into)).toBe(true)
    expect(
      opensOnDragHover(
        { kind: 'saved', collapsed: true },
        { kind: 'row', folderId: SAVED_SESSIONS_FOLDER_ID }
      )
    ).toBe(true)
    expect(
      opensOnDragHover(
        { kind: 'folder', collapsed: true },
        { kind: 'folder', parentId: 'folder-1', section: 'saved' }
      )
    ).toBe(true)
  })

  it('leaves open groups, reorders, refused drops and status groups alone', () => {
    expect(opensOnDragHover({ kind: 'folder', collapsed: false }, into)).toBe(false)
    expect(
      opensOnDragHover({ kind: 'folder', collapsed: true }, { kind: 'group', position: 'before' })
    ).toBe(false)
    expect(opensOnDragHover({ kind: 'folder', collapsed: true }, null)).toBe(false)
    expect(
      opensOnDragHover({ kind: 'completed', collapsed: true }, { kind: 'row', folderId: null })
    ).toBe(false)
  })
})
