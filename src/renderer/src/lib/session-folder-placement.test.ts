import { describe, expect, it } from 'vitest'
import type { AgentPaneCard, AttentionPane } from '@/components/attention/agent-pane-snapshot'
import { emptySessionFolderMetadata, moveSessionToFolder } from './session-folders'
import { buildSessionSidebarTree } from './session-sidebar-tree'
import { emptySessionSidebarView, moveSessionGroup } from './session-sidebar-view'
import { addSessionTaskGroups } from './session-task-sidebar-groups'
import type { SidebarSession } from './sidebar-sessions'

const folderId = '00000000-0000-4000-8000-000000000001'
const session: SidebarSession = {
  rowKey: 'row',
  sessionKey: 'session',
  worktreeId: 'workspace',
  hostId: 'local',
  tabId: 'tab',
  paneKey: 'tab:leaf',
  kind: 'terminal',
  label: 'EverFlow Integration',
  workspaceLabel: 'Marketing',
  agent: 'claude',
  unavailable: false,
  folderKeyMigration: null
}
const baseCard: AgentPaneCard = {
  paneKey: 'tab:leaf',
  worktreeId: 'workspace',
  tabId: 'tab',
  leafId: 'leaf',
  agentType: 'claude',
  bucket: 'done',
  dotState: 'done',
  unseen: false,
  title: 'EverFlow Integration',
  stateChangedAt: 10,
  repoName: 'Marketing',
  worktreeName: 'Marketing'
}
const metadata = moveSessionToFolder(
  {
    ...emptySessionFolderMetadata(),
    folders: [{ id: folderId, name: 'Waiting For' }]
  },
  'session',
  folderId
)

function build(
  card: AgentPaneCard,
  options: {
    metadata?: typeof metadata
    view?: ReturnType<typeof emptySessionSidebarView>
    attention?: AttentionPane
  } = {}
) {
  return buildSessionSidebarTree({
    now: 100,
    sessions: [session],
    metadata: options.metadata ?? metadata,
    view: options.view ?? emptySessionSidebarView(),
    query: '',
    showHidden: false,
    snapshot: {
      cardsByPaneKey: new Map([[card.paneKey, card]]),
      cardsByTabId: new Map(),
      attentionByPaneKey: new Map(options.attention ? [[card.paneKey, options.attention]] : [])
    }
  })
}

describe('explicit session folder placement', () => {
  it.each([
    { card: baseCard, state: 'done' },
    { card: { ...baseCard, bucket: 'working', dotState: 'working' }, state: 'working' },
    { card: { ...baseCard, bucket: 'idle', dotState: 'idle' }, state: 'inactive' },
    {
      card: { ...baseCard, bucket: 'working', dotState: 'working', workingMode: 'monitoring' },
      state: 'awaiting'
    },
    { card: { ...baseCard, bucket: 'idle', stopped: 'interrupted' }, state: 'interrupted' },
    {
      card: { ...baseCard, bucket: 'working', dotState: 'working', activityUnverifiable: true },
      state: 'unverifiable'
    }
  ] satisfies { card: AgentPaneCard; state: string }[])(
    'keeps $state in the selected folder with its true indicator',
    ({ card, state }) => {
      const tree = build(card)
      const folder = tree.groups.find((group) => group.folder?.id === folderId)!
      expect(folder.rows).toHaveLength(1)
      expect(folder.rows[0]!.pursuitState).toBe(state)
      expect(tree.groups.flatMap((group) => group.rows)).toHaveLength(1)
      const taskView = addSessionTaskGroups({
        groups: tree.groups,
        taskFor: () => ({ taskId: 'task', title: 'Integration' }),
        view: emptySessionSidebarView(),
        query: ''
      })
      expect(taskView.find((group) => group.folder?.id === folderId)?.rows).toEqual(folder.rows)
      expect(taskView.some((group) => group.kind === 'task')).toBe(false)
    }
  )

  it('keeps approval requests visible inside a folder and in the attention count', () => {
    const card: AgentPaneCard = { ...baseCard, bucket: 'attention', dotState: 'blocked' }
    const tree = build(card, {
      attention: { ...card, cause: 'blocked', portalPaneKey: card.paneKey }
    })
    const folder = tree.groups.find((group) => group.folder?.id === folderId)!
    expect(folder.rows[0]).toMatchObject({
      pursuitState: 'needs-you',
      attention: { cause: 'blocked' }
    })
    expect(folder.attentionCount).toBe(1)
    expect(tree.attentionCount).toBe(1)
    expect(tree.groups.some((group) => group.kind === 'attention')).toBe(false)
  })

  it('returns to the actual automatic status only after explicit unfiling', () => {
    const unfiled = moveSessionToFolder(metadata, 'session', null)
    expect(
      build(baseCard, { metadata: unfiled }).groups.find((g) => g.kind === 'completed')?.rows
    ).toHaveLength(1)
    expect(
      build({ ...baseCard, bucket: 'working' }, { metadata: unfiled }).groups.find(
        (g) => g.kind === 'workspace'
      )?.rows
    ).toHaveLength(1)
  })

  it('preserves a folder below Active across status changes and a saved-view reload', () => {
    const tree = build(baseCard)
    const view = moveSessionGroup(emptySessionSidebarView(), {
      key: `folder:${folderId}`,
      target: 'workspace:other',
      position: 'after',
      visibleKeys: tree.reorderableKeys
    })
    for (const card of [baseCard, { ...baseCard, bucket: 'working' as const }]) {
      const rebuilt = build(card, { view: JSON.parse(JSON.stringify(view)) })
      expect(rebuilt.groups.slice(0, 2).map((group) => group.key)).toEqual([
        'workspace:other',
        `folder:${folderId}`
      ])
      expect(rebuilt.groups[1]!.rows[0]!.session).toEqual(session)
    }
  })

  it('keeps a running session in its chosen saved folder', () => {
    const saved = {
      ...metadata,
      folders: [{ id: folderId, name: 'Keep', section: 'saved' as const }]
    }
    const tree = build(
      { ...baseCard, bucket: 'working' },
      {
        metadata: saved,
        view: { ...emptySessionSidebarView(), collapsed: ['saved-sessions:open'] }
      }
    )
    expect(tree.groups.find((g) => g.folder?.id === folderId)?.rows[0]?.pursuitState).toBe(
      'working'
    )
    expect(tree.groups.flatMap((g) => g.rows)).toHaveLength(1)
  })
})
