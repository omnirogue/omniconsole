import { workingSessionTestSnapshot } from './sidebar-session-test-fixtures'
import { personalViewStorageKey } from './personal-view-storage'
import {
  buildSessionSidebarTree as buildTree,
  SESSION_OTHER_GROUP_KEY,
  sessionWorkspaceGroupKey,
  sessionFolderGroupKey
} from './session-sidebar-tree'
import {
  emptySessionFolderMetadata,
  moveSessionToFolder,
  type SessionFolderMetadata
} from './session-folders'
import type { SidebarSession } from './sidebar-sessions'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { sessionSidebarSort } from './session-sidebar-sort'
import {
  emptySessionSidebarView,
  isSessionGroupCollapsed,
  moveSessionGroup,
  SESSION_WAITING_GROUP_KEY,
  orderSessionGroupKeys,
  parseSessionSidebarView,
  sessionSidebarDensity,
  setSessionGroupHidden,
  setSessionGroupsCollapsed,
  toggleSessionGroupCollapsed
} from './session-sidebar-view'
import {
  sessionSidebarViewChoice,
  withSessionSidebarViewChoice
} from './session-sidebar-view-choice'
import {
  createLocalSessionSidebarViewStorage,
  SESSION_SIDEBAR_VIEW_STORAGE_KEY
} from './session-sidebar-view-storage'

describe('session sidebar view preferences', () => {
  it('parses saved state and drops duplicate keys', () => {
    expect(
      parseSessionSidebarView({
        version: 1,
        collapsed: ['a', 'a'],
        hidden: ['b'],
        order: ['b', 'a', 'b']
      })
    ).toEqual({ version: 1, collapsed: ['a'], hidden: ['b'], order: ['b', 'a'] })
    expect(() => parseSessionSidebarView({ version: 2 })).toThrow()
  })

  it('toggles collapse, bulk collapses, and hides groups', () => {
    let view = toggleSessionGroupCollapsed(emptySessionSidebarView(), 'a')
    expect(view.collapsed).toEqual(['a'])
    view = toggleSessionGroupCollapsed(view, 'a')
    expect(view.collapsed).toEqual([])
    view = setSessionGroupsCollapsed(view, ['a', 'b'], true)
    expect(view.collapsed).toEqual(['a', 'b'])
    view = setSessionGroupsCollapsed(view, ['a'], false)
    expect(view.collapsed).toEqual(['b'])
    view = setSessionGroupHidden(view, 'c', true)
    expect(view.hidden).toEqual(['c'])
    view = setSessionGroupHidden(view, 'c', false)
    expect(view.hidden).toEqual([])
  })

  it('keeps Waiting closed by default and opens it with the same toggle', () => {
    const view = { ...emptySessionSidebarView(), collapsed: [] as string[] }
    expect(isSessionGroupCollapsed(view, SESSION_WAITING_GROUP_KEY)).toBe(true)
    const opened = toggleSessionGroupCollapsed(view, SESSION_WAITING_GROUP_KEY)
    expect(opened.collapsed).toEqual(['waiting:open'])
    expect(isSessionGroupCollapsed(opened, SESSION_WAITING_GROUP_KEY)).toBe(false)
    expect(toggleSessionGroupCollapsed(opened, SESSION_WAITING_GROUP_KEY).collapsed).toEqual([])
    // Collapse all closes it; expand all opens it, alongside the other groups.
    expect(
      setSessionGroupsCollapsed(opened, ['a', SESSION_WAITING_GROUP_KEY], true).collapsed
    ).toEqual(['a'])
    expect(
      setSessionGroupsCollapsed(view, ['a', SESSION_WAITING_GROUP_KEY], false).collapsed
    ).toEqual(['waiting:open'])
  })

  it('orders placed keys first and keeps unplaced keys in natural order', () => {
    expect(orderSessionGroupKeys(['w1', 'f1', 'w2', 'f2'], ['f2', 'w2'])).toEqual([
      'f2',
      'w2',
      'w1',
      'f1'
    ])
  })

  it('gives Drafts the slot of Waiting in an order saved without them', () => {
    // Why: Drafts split out of Waiting. Anyone who ever dragged a group has a saved order with
    // no slot for them, which filed them last, after Completed.
    expect(
      orderSessionGroupKeys(
        ['w1', 'drafts', 'waiting', 'completed'],
        ['completed', 'waiting', 'w1']
      )
    ).toEqual(['completed', 'drafts', 'waiting', 'w1'])
    // Once placed by hand, Drafts keeps its own slot.
    expect(
      orderSessionGroupKeys(['drafts', 'waiting', 'completed'], ['waiting', 'completed', 'drafts'])
    ).toEqual(['waiting', 'completed', 'drafts'])
    // A drag starts from the order on screen, so Drafts stays where the person saw it.
    const moved = moveSessionGroup(
      { ...emptySessionSidebarView(), order: ['completed', 'waiting'] },
      {
        key: 'completed',
        target: 'waiting',
        position: 'after',
        visibleKeys: ['completed', 'drafts', 'waiting']
      }
    )
    expect(moved.order).toEqual(['drafts', 'waiting', 'completed'])
  })

  it('moves a group before or after another visible group and keeps offscreen placement', () => {
    const view = { ...emptySessionSidebarView(), order: ['hidden-x'] }
    const moved = moveSessionGroup(view, {
      key: 'w2',
      target: 'f1',
      position: 'before',
      visibleKeys: ['f1', 'w1', 'w2']
    })
    expect(moved.order).toEqual(['w2', 'f1', 'w1', 'hidden-x'])
    const after = moveSessionGroup(moved, {
      key: 'w2',
      target: 'w1',
      position: 'after',
      visibleKeys: ['f1', 'w1', 'w2']
    })
    expect(after.order).toEqual(['f1', 'w1', 'w2', 'hidden-x'])
    expect(
      moveSessionGroup(after, { key: 'w2', target: 'w2', position: 'after', visibleKeys: ['w2'] })
    ).toBe(after)
    expect(
      moveSessionGroup(after, { key: 'nope', target: 'w1', position: 'after', visibleKeys: ['w1'] })
    ).toBe(after)
  })

  it('round-trips through local storage', () => {
    const backing = new Map<string, string>()
    const storage = createLocalSessionSidebarViewStorage(() => ({
      getItem: (key) => backing.get(key) ?? null,
      setItem: (key, value) => {
        backing.set(key, value)
      }
    }))
    expect(storage.load()).toEqual(emptySessionSidebarView())
    storage.save({ version: 1, collapsed: ['a'], hidden: [], order: ['a'] })
    expect(
      JSON.parse(backing.get(personalViewStorageKey(SESSION_SIDEBAR_VIEW_STORAGE_KEY))!)
    ).toMatchObject({
      collapsed: ['a']
    })
    expect(storage.load().order).toEqual(['a'])
  })
})

it.each(['waiting', 'stopped', 'completed', 'archived'])(
  'persists explicit opening of %s',
  (key) => {
    const view = emptySessionSidebarView()
    expect(isSessionGroupCollapsed(view, key)).toBe(true)
    const opened = toggleSessionGroupCollapsed(view, key)
    expect(opened.collapsed).toEqual([`${key}:open`])
    expect(isSessionGroupCollapsed(parseSessionSidebarView(opened), key)).toBe(false)
    expect(isSessionGroupCollapsed(setSessionGroupsCollapsed(opened, [key], true), key)).toBe(true)
  }
)

describe('saved view in the session tree', () => {
  const FOLDER_ID = '00000000-0000-4000-8000-000000000001'
  const FOLDER_ID_2 = '00000000-0000-4000-8000-000000000002'
  const a: SidebarSession = {
    rowKey: 'a',
    sessionKey: 'a',
    worktreeId: 'w1',
    hostId: 'local',
    tabId: 'tab',
    paneKey: 'pane',
    kind: 'terminal',
    label: 'Alpha',
    workspaceLabel: 'Work',
    agent: 'codex',
    unavailable: false,
    folderKeyMigration: null
  }
  const b = { ...a, rowKey: 'b', sessionKey: 'b', label: 'Beta' }
  function buildSessionSidebarTree(input: Partial<Parameters<typeof buildTree>[0]>) {
    return buildTree({
      now: 100,
      showArchived: false,
      sessions: [],
      metadata: emptySessionFolderMetadata(),
      view: emptySessionSidebarView(),
      snapshot: workingSessionTestSnapshot(input.sessions ?? []),
      query: '',
      showHidden: false,
      ...input
    })
  }
  it('applies saved order and hidden state to user folders, and reveals hidden folders on request', () => {
    let metadata: SessionFolderMetadata = {
      ...emptySessionFolderMetadata(),
      folders: [
        { id: FOLDER_ID, name: 'Planning' },
        { id: FOLDER_ID_2, name: 'Review' }
      ]
    }
    metadata = moveSessionToFolder(metadata, 'a', FOLDER_ID)
    metadata = moveSessionToFolder(metadata, 'b', FOLDER_ID_2)
    const view = {
      version: 1 as const,
      collapsed: [sessionFolderGroupKey(FOLDER_ID)],
      hidden: [sessionFolderGroupKey(FOLDER_ID_2)],
      order: [sessionFolderGroupKey(FOLDER_ID_2), sessionFolderGroupKey(FOLDER_ID)]
    }
    const hidden = buildSessionSidebarTree({
      sessions: [a, b],
      metadata,
      view
    })
    // Why: the remainder stays on screen as the unfile drop target once folders exist.
    expect(hidden.groups.map((group) => group.key)).toEqual([
      sessionFolderGroupKey(FOLDER_ID),
      SESSION_OTHER_GROUP_KEY,
      'saved-sessions'
    ])
    expect(hidden.groups[0]?.collapsed).toBe(true)
    expect(hidden.hiddenCount).toBe(1)
    const shown = buildSessionSidebarTree({
      sessions: [a, b],
      metadata,
      view,
      showHidden: true
    })
    expect(shown.groups.map((group) => [group.key, group.hidden])).toEqual([
      [sessionFolderGroupKey(FOLDER_ID_2), true],
      [sessionFolderGroupKey(FOLDER_ID), false],
      [SESSION_OTHER_GROUP_KEY, false],
      ['saved-sessions', false]
    ])
  })

  it('collapses, hides and reorders Active like a custom folder', () => {
    const collapsedView = { ...emptySessionSidebarView(), collapsed: [SESSION_OTHER_GROUP_KEY] }
    const collapsedTree = buildSessionSidebarTree({
      sessions: [a, b],
      view: collapsedView
    })
    expect(collapsedTree.groups).toEqual([
      expect.objectContaining({ key: SESSION_OTHER_GROUP_KEY, collapsed: true, canReorder: true }),
      expect.objectContaining({ key: 'saved-sessions', collapsed: true })
    ])
    expect(collapsedTree.reorderableKeys).toEqual([SESSION_OTHER_GROUP_KEY])

    const hiddenView = { ...emptySessionSidebarView(), hidden: [SESSION_OTHER_GROUP_KEY] }
    const hiddenTree = buildSessionSidebarTree({
      sessions: [a, b],
      view: hiddenView
    })
    expect(hiddenTree.groups.map((group) => group.key)).toEqual(['saved-sessions'])
    expect(hiddenTree.hiddenCount).toBe(1)
    const shownTree = buildSessionSidebarTree({
      sessions: [a, b],
      view: hiddenView,
      showHidden: true
    })
    expect(shownTree.groups[0]).toMatchObject({ key: SESSION_OTHER_GROUP_KEY, hidden: true })
  })
  it('unfiles a filed conversation dropped on the remainder group, from any workspace', () => {
    // Why: this is the drag contract the sidebar relies on — resolveSessionGroupDrop
    // treats a drop as an unfile only when the row's own workspace group key matches
    // the group it lands on. Since every session now shares SESSION_OTHER_GROUP_KEY,
    // that match holds regardless of which host/worktree the session came from.
    const metadata = moveSessionToFolder(
      { ...emptySessionFolderMetadata(), folders: [{ id: FOLDER_ID, name: 'Planning' }] },
      'b',
      FOLDER_ID
    )
    const tree = buildSessionSidebarTree({
      sessions: [a, b],
      metadata
    })
    const otherGroup = tree.groups.find((group) => group.key === SESSION_OTHER_GROUP_KEY)!
    expect(otherGroup.kind).toBe('workspace')
    // b lives on a different host/worktree than a, yet its drag key still matches
    // the one remainder group it would be dropped back onto to unfile it.
    expect(sessionWorkspaceGroupKey(b)).toBe(otherGroup.key)
  })
  it('keeps empty folders and the remainder as drop targets once folders exist', () => {
    const tree = buildSessionSidebarTree({
      sessions: [],
      metadata: { ...emptySessionFolderMetadata(), folders: [{ id: FOLDER_ID, name: 'Later' }] }
    })
    expect(tree.groups.map((group) => group.key)).toEqual([
      sessionFolderGroupKey(FOLDER_ID),
      SESSION_OTHER_GROUP_KEY,
      'saved-sessions'
    ])
    expect(tree.groups[0]?.rows).toEqual([])
    // Why: with no folders at all there is nothing to unfile into, so an empty remainder stays off screen.
    expect(buildSessionSidebarTree({ sessions: [] }).groups.map((group) => group.key)).toEqual([
      'saved-sessions'
    ])
  })
})

describe('row density', () => {
  it('reads compact when a saved view predates the preference, and keeps a saved choice', () => {
    const legacy = parseSessionSidebarView({ version: 1, collapsed: [], hidden: [], order: [] })
    expect(legacy.density).toBeUndefined()
    expect(sessionSidebarDensity(legacy)).toBe('compact')
    expect(
      sessionSidebarDensity(
        parseSessionSidebarView({
          version: 1,
          collapsed: [],
          hidden: [],
          order: [],
          density: 'comfortable'
        })
      )
    ).toBe('comfortable')
    expect(() =>
      parseSessionSidebarView({ version: 1, collapsed: [], hidden: [], order: [], density: 'x' })
    ).toThrow()
  })
})

describe('View picker choice', () => {
  it('defaults existing views to Sessions and retains an explicit grouping choice', () => {
    expect(sessionSidebarViewChoice(emptySessionSidebarView())).toBe('flat')
    expect(sessionSidebarViewChoice({ layout: 'full' })).toBe('flat')
    expect(sessionSidebarViewChoice({ flat: false, layout: 'full' })).toBe('folders')
    // Why: an older build could save a Group-by view over Focus; the lens is what groups the list.
    expect(sessionSidebarViewChoice({ layout: 'focus', lens: 'project' })).toBe('project')
  })

  it('keeps Status or Task under Focus and Folders, and opens a Group-by view in full', () => {
    const task = { ...emptySessionSidebarView(), groupBy: 'task' as const }
    expect(withSessionSidebarViewChoice(task, 'folders')).toMatchObject({
      groupBy: 'task',
      layout: 'full'
    })
    const byComputer = withSessionSidebarViewChoice(task, 'computer')
    expect(byComputer).toMatchObject({ lens: 'computer', layout: 'full' })
    expect(byComputer.groupBy).toBeUndefined()
    const back = withSessionSidebarViewChoice(byComputer, 'focus')
    expect(back.lens).toBeUndefined()
    expect(back.layout).toBe('focus')
  })

  it('saves a choice an older build can still read', () => {
    const saved = withSessionSidebarViewChoice(emptySessionSidebarView(), 'blocking')
    expect(parseSessionSidebarView(JSON.parse(JSON.stringify(saved)))).toMatchObject({
      lens: 'blocking',
      layout: 'full'
    })
  })
})

describe('row sort', () => {
  it('defaults to Status, or Manual while a dragged order exists, and keeps a chosen sort', () => {
    expect(sessionSidebarSort(emptySessionSidebarView())).toBe('status')
    expect(sessionSidebarSort({ rowOrder: ['a'] })).toBe('manual')
    expect(sessionSidebarSort({ rowOrder: ['a'], sort: 'name' })).toBe('name')
  })

  it('round-trips a saved sort, and reads one this build does not know as the default', () => {
    const saved = { ...emptySessionSidebarView(), sort: 'host', layout: 'full' }
    expect(parseSessionSidebarView(JSON.parse(JSON.stringify(saved))).sort).toBe('host')
    const newer = parseSessionSidebarView({ ...saved, sort: 'recent-activity' })
    expect(newer.sort).toBeUndefined()
    expect(newer.layout).toBe('full')
    expect(sessionSidebarSort(newer)).toBe('status')
  })

  it('saves a sort an older build ignores without failing the view', () => {
    const olderBuild = z.object({
      version: z.literal(1),
      collapsed: z.array(z.string()),
      hidden: z.array(z.string()),
      order: z.array(z.string()),
      layout: z.enum(['focus', 'full']).optional()
    })
    const read = olderBuild.safeParse({
      ...emptySessionSidebarView(),
      sort: 'name',
      layout: 'full'
    })
    expect(read.success).toBe(true)
    expect(read.data).not.toHaveProperty('sort')
  })
})
