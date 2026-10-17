import { describe, expect, it } from 'vitest'
import type { AgentPaneCard, AttentionPane } from '@/components/attention/agent-pane-snapshot'
import { emptySessionFolderMetadata, type SessionFolderMetadata } from './session-folders'
import { sessionFolderRowState, sessionFolderTallies } from './session-folder-rollup'
import type { SessionSidebarTreeRow } from './session-sidebar-group-model'
import { emptySessionSidebarView } from './session-sidebar-view'
import { buildSessionSidebarTree, sessionFolderGroupKey } from './session-sidebar-tree'
import type { SidebarSession } from './sidebar-sessions'

const now = 1_000_000_000
const BATCH = '00000000-0000-4000-8000-00000000000b'
const MINE = '00000000-0000-4000-8000-00000000000a'
const ORIGIN = { requestExcerpt: 'fix PDF export, Refer & Earn copy', createdAt: now - 60_000 }

function session(key: string, over: Partial<SidebarSession> = {}): SidebarSession {
  return {
    rowKey: key,
    sessionKey: key,
    worktreeId: 'w1',
    hostId: 'local',
    tabId: `tab-${key}`,
    paneKey: `tab-${key}:leaf`,
    kind: 'terminal',
    label: key,
    workspaceLabel: 'Website / main',
    agent: 'codex',
    unavailable: false,
    folderKeyMigration: null,
    ...over
  }
}

function card(paneKey: string, dotState: AgentPaneCard['dotState']): AgentPaneCard {
  return {
    paneKey,
    worktreeId: 'w1',
    tabId: paneKey.split(':')[0]!,
    leafId: 'leaf',
    agentType: 'codex',
    bucket: dotState === 'working' ? 'working' : 'idle',
    dotState,
    unseen: false,
    title: 'task',
    stateChangedAt: now - 1000,
    repoName: 'Website',
    worktreeName: 'main'
  } as AgentPaneCard
}

function metadata(membership: Record<string, string>): SessionFolderMetadata {
  return {
    ...emptySessionFolderMetadata(),
    folders: [
      { id: BATCH, name: 'Launch · 09:25 · Fix PDF export' },
      { id: MINE, name: 'Planning' }
    ],
    membership
  }
}

function build(input: {
  sessions: SidebarSession[]
  membership: Record<string, string>
  archived?: string[]
  cards?: AgentPaneCard[]
  asking?: string[]
  collapsed?: string[]
  showArchived?: boolean
}) {
  const attention = new Map<string, AttentionPane>(
    (input.asking ?? []).map((paneKey) => [
      paneKey,
      { ...card(paneKey, 'waiting'), bucket: 'attention', cause: 'waiting', portalPaneKey: paneKey }
    ])
  )
  return buildSessionSidebarTree({
    now,
    sessions: input.sessions,
    metadata: metadata(input.membership),
    view: { ...emptySessionSidebarView(), collapsed: input.collapsed ?? [] },
    snapshot: {
      cardsByPaneKey: new Map((input.cards ?? []).map((entry) => [entry.paneKey, entry])),
      cardsByTabId: new Map(),
      attentionByPaneKey: attention
    },
    query: '',
    showHidden: false,
    showArchived: input.showArchived ?? false,
    archivedKeys: new Set(input.archived ?? []),
    batchOrigins: { [BATCH]: ORIGIN }
  })
}

const folderGroup = (tree: ReturnType<typeof build>, id: string) =>
  tree.groups.find((group) => group.key === sessionFolderGroupKey(id))

describe('folder rollups', () => {
  it('counts every state of a folder, archived rows as done and unreachable rows apart', () => {
    const rows = ['work', 'ask', 'gone', 'shelved', 'finished'].map((key) =>
      session(key, key === 'gone' ? { unavailable: true } : {})
    )
    const tree = build({
      sessions: rows,
      membership: Object.fromEntries(rows.map((row) => [row.sessionKey!, BATCH])),
      archived: ['shelved'],
      cards: [
        card('tab-work:leaf', 'working'),
        card('tab-gone:leaf', 'working'),
        card('tab-finished:leaf', 'done')
      ],
      asking: ['tab-ask:leaf']
    })
    const batch = folderGroup(tree, BATCH)!
    expect(batch.folderTally).toEqual({
      working: 1,
      needsYou: 1,
      waiting: 0,
      stopped: 0,
      cantSee: 1,
      done: 2,
      total: 5
    })
    expect(batch.batchOrigin).toEqual(ORIGIN)
    expect(folderGroup(tree, MINE)!.batchOrigin).toBeUndefined()
  })

  it('keeps showing a row that needs the person under a collapsed folder', () => {
    const rows = [session('ask'), session('work')]
    const tree = build({
      sessions: rows,
      membership: { ask: BATCH, work: BATCH },
      cards: [card('tab-work:leaf', 'working')],
      asking: ['tab-ask:leaf'],
      collapsed: [sessionFolderGroupKey(BATCH)]
    })
    const batch = folderGroup(tree, BATCH)!
    expect(batch.collapsed).toBe(true)
    expect(batch.peekRows?.map((row) => row.session.label)).toEqual(['ask'])
  })
})

describe('settled batch folders', () => {
  const rows = [session('one'), session('two'), session('mine')]
  const membership = { one: BATCH, two: BATCH, mine: MINE }

  it('leave the default view once every session in them is archived', () => {
    const tree = build({ sessions: rows, membership, archived: ['one', 'two', 'mine'] })
    expect(folderGroup(tree, BATCH)).toBeUndefined()
    // A folder the person made never hides itself, even with every row archived.
    expect(folderGroup(tree, MINE)).toBeDefined()
    const shown = build({
      sessions: rows,
      membership,
      archived: ['one', 'two', 'mine'],
      showArchived: true
    })
    expect(folderGroup(shown, BATCH)?.folderTally).toMatchObject({ done: 2, total: 2 })
  })

  it('stay while any session in them is not archived', () => {
    const tree = build({ sessions: rows, membership, archived: ['one'] })
    expect(folderGroup(tree, BATCH)).toBeDefined()
  })
})

describe('sessionFolderRowState', () => {
  const row = (over: Partial<SessionSidebarTreeRow>): SessionSidebarTreeRow => ({
    session: session('r'),
    folderId: BATCH,
    attention: null,
    state: null,
    waitingUntil: null,
    ...over
  })

  it('reads waiting, stopped, idle and unverified rows the way their own tint does', () => {
    expect(sessionFolderRowState(row({ waitingUntil: '2026-09-26T10:00:00Z' }))).toBe('waiting')
    expect(sessionFolderRowState(row({ state: 'monitoring' }))).toBe('waiting')
    expect(sessionFolderRowState(row({ state: 'failed' }))).toBe('stopped')
    expect(sessionFolderRowState(row({ state: 'idle' }))).toBe('done')
    expect(sessionFolderRowState(row({ state: null }))).toBeNull()
    expect(sessionFolderRowState(row({ activityUnverifiable: true, state: 'done' }))).toBe(
      'cantSee'
    )
    // Unreachable is never done, even once archived.
    expect(
      sessionFolderRowState(row({ archived: true, session: session('r', { unavailable: true }) }))
    ).toBe('cantSee')
  })

  it('adds nested folders into their parent', () => {
    const folders = [
      { id: 'parent', name: 'Client' },
      { id: 'child', name: 'Q3', parentId: 'parent' }
    ]
    const tallies = sessionFolderTallies(
      folders,
      [row({ folderId: 'child', state: 'working' }), row({ folderId: 'parent', state: 'done' })],
      new Map()
    )
    expect(tallies.get('parent')).toMatchObject({ working: 1, done: 1, total: 2 })
    expect(tallies.get('child')).toMatchObject({ working: 1, total: 1 })
  })
})
