import { describe, expect, it } from 'vitest'
import type { AgentPaneCard, AttentionPane } from '@/components/attention/agent-pane-snapshot'
import { conversationPlanFixture } from './conversation-plan-fixture'
import { emptySessionFolderMetadata, moveSessionToFolder } from './session-folders'
import { buildSessionSidebarTree } from './session-sidebar-tree'
import { emptySessionSidebarView, setSessionGroupsCollapsed } from './session-sidebar-view'
import { SESSION_WORKERS_GROUP_KEY, sessionWorkersKey } from './session-sidebar-worker-keys'
import type { SidebarSession } from './sidebar-sessions'

const FOLDER_ID = '00000000-0000-4000-8000-000000000001'
const leaf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function session(key: string, n: number, overrides: Partial<SidebarSession> = {}): SidebarSession {
  return {
    rowKey: key,
    sessionKey: key,
    worktreeId: 'w1',
    hostId: 'local',
    tabId: `tab-${n}`,
    paneKey: `tab-${n}:${leaf(n)}`,
    kind: 'terminal',
    label: key,
    workspaceLabel: 'Website / main',
    agent: 'codex',
    unavailable: false,
    folderKeyMigration: null,
    ...overrides
  }
}

function card(paneKey: string, bucket: AgentPaneCard['bucket']): AgentPaneCard {
  return {
    paneKey,
    worktreeId: 'w1',
    tabId: paneKey.split(':')[0]!,
    leafId: paneKey.split(':')[1] ?? null,
    agentType: 'codex',
    bucket,
    dotState: bucket === 'attention' ? 'waiting' : 'working',
    unseen: false,
    title: 'task',
    stateChangedAt: 10,
    repoName: 'Website',
    worktreeName: 'main'
  }
}

const coordinator = session('coordinator', 1)
const reviewers = [2, 3, 4].map((n) => session(`reviewer-${n}`, n))
const mine = session('mine', 9)
// Worker leaf → the leaf of the session that dispatched it (orchestration.workerLineage).
const lineage = new Map(reviewers.map((row) => [row.paneKey!.split(':')[1]!, leaf(1)]))

function build(overrides: Partial<Parameters<typeof buildSessionSidebarTree>[0]> = {}) {
  const sessions = overrides.sessions ?? [coordinator, ...reviewers, mine]
  return buildSessionSidebarTree({
    now: 100,
    sessions,
    metadata: emptySessionFolderMetadata(),
    view: emptySessionSidebarView(),
    snapshot: {
      cardsByPaneKey: new Map(sessions.map((row) => [row.paneKey!, card(row.paneKey!, 'working')])),
      cardsByTabId: new Map(),
      attentionByPaneKey: new Map()
    },
    query: '',
    showHidden: false,
    workerParentByLeaf: lineage,
    ...overrides
  })
}

const listed = (tree: ReturnType<typeof build>, kind: string) =>
  tree.groups.find((group) => group.kind === kind)?.rows.map((row) => row.session.rowKey)

describe('workers nest under the session that launched them', () => {
  it('lists only the launcher and the person’s own session, and counts the workers on it', () => {
    const tree = build()
    expect(listed(tree, 'workspace')).toEqual(['coordinator', 'mine'])
    const launcher = tree.groups[0]!.rows.find((row) => row.session.rowKey === 'coordinator')
    expect(launcher?.workers).toEqual({ count: 3, running: 3, expanded: false })
    expect(tree.groups[0]!.rows.find((row) => row.session.rowKey === 'mine')?.workers).toBe(
      undefined
    )
  })

  it('lists the workers under the launcher, in its group, once it is expanded', () => {
    const view = setSessionGroupsCollapsed(
      emptySessionSidebarView(),
      [sessionWorkersKey('coordinator')],
      false
    )
    const rows = build({ view }).groups[0]!.rows
    expect(rows.map((row) => [row.session.rowKey, row.workerOf, row.subagent])).toEqual([
      ['coordinator', undefined, undefined],
      ['reviewer-2', 'coordinator', true],
      ['reviewer-3', 'coordinator', true],
      ['reviewer-4', 'coordinator', true],
      ['mine', undefined, undefined]
    ])
  })

  it('keeps every session at the top without a lineage record', () => {
    expect(listed(build({ workerParentByLeaf: new Map() }), 'workspace')).toHaveLength(5)
  })

  it('keeps a worker whose launcher is gone in the folded Agent sessions group', () => {
    const tree = build({ sessions: [...reviewers, mine] })
    expect(listed(tree, 'workspace')).toEqual(['mine'])
    const group = tree.groups.find((entry) => entry.key === SESSION_WORKERS_GROUP_KEY)
    expect(group).toMatchObject({ kind: 'workers', label: 'Agent sessions (3)', collapsed: true })
    expect(group?.rows.map((row) => row.session.rowKey)).toEqual([
      'reviewer-2',
      'reviewer-3',
      'reviewer-4'
    ])
    expect(group?.rows.every((row) => row.subagent)).toBe(true)
  })

  it('never hides a worker that asks for the person, or one the person filed', () => {
    const asking = reviewers[0]!
    const attention: AttentionPane = {
      ...card(asking.paneKey!, 'attention'),
      cause: 'waiting',
      portalPaneKey: asking.paneKey!
    }
    const sessions = [coordinator, ...reviewers, mine]
    const tree = build({
      metadata: moveSessionToFolder(
        { ...emptySessionFolderMetadata(), folders: [{ id: FOLDER_ID, name: 'Audit' }] },
        'reviewer-3',
        FOLDER_ID
      ),
      snapshot: {
        cardsByPaneKey: new Map(
          sessions.map((row) => [
            row.paneKey!,
            card(row.paneKey!, row === asking ? 'attention' : 'working')
          ])
        ),
        cardsByTabId: new Map(),
        attentionByPaneKey: new Map([[asking.paneKey!, attention]])
      }
    })
    expect(listed(tree, 'attention')).toEqual(['reviewer-2'])
    expect(listed(tree, 'folder')).toEqual(['reviewer-3'])
    expect(
      tree.groups.flatMap((group) => group.rows).find((row) => row.session.rowKey === 'coordinator')
        ?.workers
    ).toMatchObject({ count: 1 })
  })

  it('finds a folded worker by search', () => {
    const tree = build({ query: 'reviewer-3' })
    const [row] = tree.groups.flatMap((group) => group.rows)
    expect(row?.session.rowKey).toBe('reviewer-3')
    expect(row?.subagent).toBe(true)
  })

  it('does not infer subagent identity from a conversation title', () => {
    const ordinary = session('ordinary', 11, { label: 'SUB · reviewed by Sal' })
    const tree = build({ sessions: [ordinary], workerParentByLeaf: new Map() })
    expect(tree.groups.flatMap((group) => group.rows)[0]?.subagent).toBeUndefined()
  })

  it('does not keep the SUB role from remembered parent grouping without current lineage', () => {
    const view = setSessionGroupsCollapsed(
      emptySessionSidebarView(),
      [sessionWorkersKey('coordinator')],
      false
    )
    const rows = build({ view, workerSubagentLeaves: new Set() }).groups[0]!.rows
    expect(rows.find((row) => row.session.rowKey === 'reviewer-2')).toMatchObject({
      workerOf: 'coordinator'
    })
    expect(rows.find((row) => row.session.rowKey === 'reviewer-2')?.subagent).toBeUndefined()
  })

  it('nests under the top launcher and survives a lineage loop', () => {
    const grandchild = session('grandchild', 5)
    const chained = new Map([...lineage, [leaf(5), leaf(2)]])
    const tree = build({
      sessions: [coordinator, ...reviewers, grandchild],
      workerParentByLeaf: chained
    })
    expect(listed(tree, 'workspace')).toEqual(['coordinator'])
    expect(tree.groups[0]!.rows[0]!.workers?.count).toBe(4)
    const loop = new Map([
      [leaf(1), leaf(9)],
      [leaf(9), leaf(1)]
    ])
    expect(listed(build({ workerParentByLeaf: loop }), 'workspace')).toContain('coordinator')
  })

  it("keeps a finished plan's seats under the plan's row", () => {
    const source = session('source', 20, { tabId: 'source', worktreeId: 'folder:1' })
    const seats = [1, 2, 3].map((n) =>
      session(`seat${n}`, 20 + n, { tabId: `worker-task${n}`, worktreeId: 'folder:1' })
    )
    const chain = conversationPlanFixture()
    chain.state = 'done'
    const tree = build({
      sessions: [source, ...seats],
      workerParentByLeaf: new Map(),
      chainByRowKey: new Map([['source', chain]])
    })
    const rows = tree.groups.flatMap((group) => group.rows)
    expect(rows.map((row) => row.session.rowKey)).toEqual(['source'])
    expect(rows[0]!.workers?.count).toBe(3)
  })
})
