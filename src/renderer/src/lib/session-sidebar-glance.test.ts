import { describe, expect, it } from 'vitest'
import type { AgentPaneCard, AttentionPane } from '@/components/attention/agent-pane-snapshot'
import {
  emptySessionFolderMetadata,
  moveSessionToFolder,
  SAVED_SESSIONS_FOLDER_ID
} from './session-folders'
import { sessionGroupColor, ownSessionGroupColor } from './session-folder-colors'
import { sessionRowTone } from './session-row-tone'
import { buildSessionSidebarTree, sessionGroupListedRows } from './session-sidebar-tree'
import {
  emptySessionSidebarView,
  isSessionGroupCollapsed,
  sessionFolderGroupKey,
  setSessionArchivedAt,
  toggleSessionGroupCollapsed
} from './session-sidebar-view'
import type { SidebarSession } from './sidebar-sessions'

const FOLDER_ID = '00000000-0000-4000-8000-000000000001'
const CHILD_ID = '00000000-0000-4000-8000-000000000002'

function session(key: string, paneKey: string): SidebarSession {
  return {
    rowKey: key,
    sessionKey: key,
    worktreeId: 'w1',
    hostId: 'local',
    tabId: paneKey.split(':')[0]!,
    paneKey,
    kind: 'terminal',
    label: key,
    workspaceLabel: 'Website / main',
    agent: 'codex',
    unavailable: false,
    folderKeyMigration: null
  }
}

function card(
  paneKey: string,
  bucket: AgentPaneCard['bucket'],
  dotState: AgentPaneCard['dotState']
): AgentPaneCard {
  return {
    paneKey,
    worktreeId: 'w1',
    tabId: paneKey.split(':')[0]!,
    leafId: paneKey.split(':')[1] ?? null,
    agentType: 'codex',
    bucket,
    dotState,
    unseen: false,
    title: 'task',
    stateChangedAt: 10,
    repoName: 'Website',
    worktreeName: 'main'
  }
}

describe('folders start folded', () => {
  it('reads a folder as collapsed until the person opens it, and remembers the opening', () => {
    const key = sessionFolderGroupKey(FOLDER_ID)
    const view = emptySessionSidebarView()
    expect(isSessionGroupCollapsed(view, key)).toBe(true)
    const opened = toggleSessionGroupCollapsed(view, key)
    expect(opened.collapsed).toEqual([`${key}:open`])
    expect(isSessionGroupCollapsed(opened, key)).toBe(false)
    expect(isSessionGroupCollapsed(toggleSessionGroupCollapsed(opened, key), key)).toBe(true)
  })

  it('keeps the unfiled Active group open by default', () => {
    expect(isSessionGroupCollapsed(emptySessionSidebarView(), 'workspace:other')).toBe(false)
  })
})

describe('a folded folder still lists what needs you', () => {
  const asking = session('asking', 'tab-1:leaf-1')
  const working = session('working', 'tab-2:leaf-2')
  const metadata = [asking, working].reduce(
    (next, entry) => moveSessionToFolder(next, entry.sessionKey!, FOLDER_ID),
    { ...emptySessionFolderMetadata(), folders: [{ id: FOLDER_ID, name: 'Client A' }] }
  )
  const attention: AttentionPane = {
    ...card('tab-1:leaf-1', 'attention', 'waiting'),
    cause: 'waiting',
    portalPaneKey: 'tab-1:leaf-1'
  }
  const snapshot = {
    cardsByPaneKey: new Map([
      ['tab-1:leaf-1', card('tab-1:leaf-1', 'attention', 'waiting')],
      ['tab-2:leaf-2', card('tab-2:leaf-2', 'working', 'working')]
    ]),
    cardsByTabId: new Map(),
    attentionByPaneKey: new Map([['tab-1:leaf-1', attention]])
  }
  const build = (collapsed: string[] = []) =>
    buildSessionSidebarTree({
      now: 100,
      showArchived: false,
      sessions: [asking, working],
      metadata,
      view: { ...emptySessionSidebarView(), collapsed },
      snapshot,
      query: '',
      showHidden: false
    })

  it('folds the folder but peeks the question under its heading', () => {
    const folder = build().groups.find((group) => group.key === sessionFolderGroupKey(FOLDER_ID))!
    expect(folder.collapsed).toBe(true)
    expect(folder.rows.map((row) => row.session.label)).toEqual(['asking', 'working'])
    expect(sessionGroupListedRows(folder).map((row) => row.session.label)).toEqual(['asking'])
    expect(folder.attentionCount).toBe(1)
  })

  it('lists every row once the folder is open', () => {
    const folder = build([`${sessionFolderGroupKey(FOLDER_ID)}:open`]).groups.find(
      (group) => group.key === sessionFolderGroupKey(FOLDER_ID)
    )!
    expect(folder.collapsed).toBe(false)
    expect(sessionGroupListedRows(folder).map((row) => row.session.label)).toEqual([
      'asking',
      'working'
    ])
  })
})

describe('archived rows carry when they were put away', () => {
  it('stamps each row once, keeps the first stamp, and clears it on unarchive', () => {
    const first = setSessionArchivedAt(emptySessionSidebarView(), ['a'], true, 10)
    const again = setSessionArchivedAt(first, ['a', 'b'], true, 20)
    expect(again.archivedAt).toEqual({ a: 10, b: 20 })
    expect(setSessionArchivedAt(again, ['a'], false, 30).archivedAt).toEqual({ b: 20 })
  })

  it('lists Archived newest first, with unstamped rows after the stamped ones', () => {
    const rows = ['old', 'new', 'legacy'].map((key, index) =>
      session(key, `tab-${index}:leaf-${index}`)
    )
    const tree = buildSessionSidebarTree({
      now: 100,
      showArchived: true,
      sessions: rows,
      metadata: emptySessionFolderMetadata(),
      view: {
        ...emptySessionSidebarView(),
        archived: ['old', 'new', 'legacy'],
        archivedAt: { old: 10, new: 50 }
      },
      snapshot: {
        cardsByPaneKey: new Map(),
        cardsByTabId: new Map(),
        attentionByPaneKey: new Map()
      },
      query: '',
      showHidden: false
    })
    const archived = tree.groups.find((group) => group.kind === 'archived')!
    expect(archived.rows.map((row) => row.session.label)).toEqual(['new', 'old', 'legacy'])
  })
})

describe('folder colors', () => {
  const parent = { id: FOLDER_ID, name: 'Clients', section: 'saved' as const }
  const child = { ...parent, id: CHILD_ID, name: 'Acme', parentId: FOLDER_ID }
  const folders = [parent, child]

  it('ignores a stored value that is not one of the palette colors', () => {
    expect(ownSessionGroupColor({ colors: { x: '#ff0000' } }, 'x')).toBeNull()
    expect(ownSessionGroupColor({ colors: { x: 'teal' } }, 'x')).toBe('teal')
  })

  it('inherits the nearest colored parent, then Saved Sessions, and prefers its own', () => {
    const childKey = sessionFolderGroupKey(CHILD_ID)
    expect(
      sessionGroupColor(
        { colors: { [SAVED_SESSIONS_FOLDER_ID]: 'gray' } },
        childKey,
        child,
        folders
      )
    ).toBe('gray')
    expect(
      sessionGroupColor(
        {
          colors: { [SAVED_SESSIONS_FOLDER_ID]: 'gray', [sessionFolderGroupKey(FOLDER_ID)]: 'blue' }
        },
        childKey,
        child,
        folders
      )
    ).toBe('blue')
    expect(
      sessionGroupColor(
        { colors: { [sessionFolderGroupKey(FOLDER_ID)]: 'blue', [childKey]: 'pink' } },
        childKey,
        child,
        folders
      )
    ).toBe('pink')
  })

  it('never inherits Saved Sessions into a live folder', () => {
    const live = { id: FOLDER_ID, name: 'Now' }
    expect(
      sessionGroupColor(
        { colors: { [SAVED_SESSIONS_FOLDER_ID]: 'gray' } },
        sessionFolderGroupKey(FOLDER_ID),
        live,
        [live]
      )
    ).toBeNull()
  })
})

describe('row tones', () => {
  it('reads green while working, peach while it needs you, untinted done', () => {
    expect(sessionRowTone({ visualState: 'working', needsYou: false, putAway: false })).toBe(
      'active'
    )
    expect(sessionRowTone({ visualState: 'running', needsYou: false, putAway: false })).toBe(
      'active'
    )
    expect(sessionRowTone({ visualState: 'done', needsYou: false, putAway: false })).toBe('done')
    expect(sessionRowTone({ visualState: 'working', needsYou: true, putAway: false })).toBe(
      'needs-you'
    )
  })

  it('tints waiting rows blue and stopped rows grey', () => {
    for (const visualState of ['waiting', 'awaiting', 'queued'] as const) {
      expect(sessionRowTone({ visualState, needsYou: false, putAway: false })).toBe('waiting')
    }
    for (const visualState of ['failed', 'interrupted'] as const) {
      expect(sessionRowTone({ visualState, needsYou: false, putAway: false })).toBe('stopped')
    }
    expect(sessionRowTone({ visualState: 'none', needsYou: false, putAway: false })).toBeNull()
  })

  it('lets a saved or archived row take its folder color, except for a question', () => {
    expect(sessionRowTone({ visualState: 'done', needsYou: false, putAway: true })).toBeNull()
    expect(sessionRowTone({ visualState: 'done', needsYou: true, putAway: true })).toBe('needs-you')
  })
})
