import { normalizeSessionChain } from '../../../shared/session-chain-types'
import { describe, expect, it } from 'vitest'
import type { AgentPaneCard, AttentionPane } from '@/components/attention/agent-pane-snapshot'
import { emptySessionFolderMetadata, moveSessionToFolder } from './session-folders'
import { emptySessionSidebarView } from './session-sidebar-view'
import {
  buildSessionSidebarTree as buildTree,
  SESSION_ATTENTION_GROUP_KEY,
  SESSION_OTHER_GROUP_KEY,
  sessionFolderGroupKey,
  sessionWorkspaceGroupKey
} from './session-sidebar-tree'
import type { SidebarSession } from './sidebar-sessions'

const FOLDER_ID = '00000000-0000-4000-8000-000000000001'

function session(overrides: Partial<SidebarSession>): SidebarSession {
  return {
    rowKey: overrides.rowKey ?? overrides.sessionKey ?? 'row',
    sessionKey: 'session',
    worktreeId: 'w1',
    hostId: 'local',
    tabId: 'tab-1',
    paneKey: 'tab-1:leaf-1',
    kind: 'terminal',
    label: 'Build landing page',
    workspaceLabel: 'Website / main',
    agent: 'codex',
    unavailable: false,
    folderKeyMigration: null,
    ...overrides
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

function attentionPane(paneKey: string): AttentionPane {
  return { ...card(paneKey, 'attention', 'waiting'), cause: 'waiting', portalPaneKey: paneKey }
}

function emptySnapshot() {
  return { cardsByPaneKey: new Map(), cardsByTabId: new Map(), attentionByPaneKey: new Map() }
}

function buildSessionSidebarTree(input: Partial<Parameters<typeof buildTree>[0]>) {
  return buildTree({
    now: 100,
    showArchived: false,
    sessions: [],
    metadata: emptySessionFolderMetadata(),
    view: emptySessionSidebarView(),
    snapshot: {
      ...emptySnapshot(),
      cardsByPaneKey: new Map(
        (input.sessions ?? []).flatMap((session) =>
          session.paneKey && !input.chainByRowKey?.has(session.rowKey)
            ? [[session.paneKey, card(session.paneKey, 'working', 'working')]]
            : []
        )
      )
    },
    query: '',
    showHidden: false,
    ...input
  })
}

describe('buildSessionSidebarTree', () => {
  const a = session({ sessionKey: 'a', paneKey: 'tab-1:leaf-1', label: 'Alpha' })
  const b = session({
    sessionKey: 'b',
    paneKey: 'tab-2:leaf-2',
    tabId: 'tab-2',
    worktreeId: 'w2',
    workspaceLabel: 'Api / main',
    label: 'Beta'
  })

  it('keeps settled declared benchmarks in Hidden and preserves ordinary, running and filed work', () => {
    const workflow = (key: string, origin?: 'benchmark', status: 'done' | 'running' = 'done') =>
      session({
        rowKey: key,
        sessionKey: key,
        paneKey: null,
        workflow: { preset: 'discover', status, ...(origin ? { origin } : {}) }
      })
    const benchmark = workflow('benchmark', 'benchmark')
    const person = workflow('person')
    const running = workflow('running', 'benchmark', 'running')
    const tree = buildSessionSidebarTree({ sessions: [benchmark, person, running] })
    expect(
      tree.groups.find((group) => group.kind === 'hidden')?.rows.map((row) => row.session.rowKey)
    ).toEqual(['benchmark'])
    expect(
      tree.groups.find((group) => group.kind === 'completed')?.rows.map((row) => row.session.rowKey)
    ).toEqual(['person'])
    expect(
      tree.groups
        .find((group) => group.key === SESSION_OTHER_GROUP_KEY)
        ?.rows.map((row) => row.session.rowKey)
    ).toEqual(['running'])
    const metadata = moveSessionToFolder(
      { ...emptySessionFolderMetadata(), folders: [{ id: FOLDER_ID, name: 'Keep' }] },
      'benchmark',
      FOLDER_ID
    )
    const filed = buildSessionSidebarTree({ sessions: [benchmark], metadata })
    expect(filed.groups.find((group) => group.kind === 'hidden')).toBeUndefined()
    expect(filed.groups.find((group) => group.kind === 'folder')?.rows[0]?.session).toEqual(
      benchmark
    )
  })

  it('groups executing unfiled sessions into Active and executing filed sessions by folder', () => {
    const metadata = moveSessionToFolder(
      { ...emptySessionFolderMetadata(), folders: [{ id: FOLDER_ID, name: 'Planning' }] },
      'a',
      FOLDER_ID
    )
    const tree = buildSessionSidebarTree({
      sessions: [a, b],
      metadata
    })
    expect(
      tree.groups.map((group) => [group.key, group.rows.map((row) => row.session.label)])
    ).toEqual([
      [sessionFolderGroupKey(FOLDER_ID), ['Alpha']],
      [SESSION_OTHER_GROUP_KEY, ['Beta']],
      ['saved-sessions', []]
    ])
    expect(tree.groups[0]?.folder?.name).toBe('Planning')
    expect(tree.reorderableKeys).toEqual([
      sessionFolderGroupKey(FOLDER_ID),
      SESSION_OTHER_GROUP_KEY
    ])
    expect(tree.totalRows).toBe(2)
    // sessionWorkspaceGroupKey always returns the one remainder key now, regardless of
    // which host/worktree the session came from — that is what keeps a drag payload
    // built from a's or b's session (different worktrees) matching this one group.
    expect(sessionWorkspaceGroupKey(a)).toBe(SESSION_OTHER_GROUP_KEY)
    expect(sessionWorkspaceGroupKey(b)).toBe(SESSION_OTHER_GROUP_KEY)
  })

  it('pins a Needs you group first, marks rows, and counts per group', () => {
    const snapshot = {
      cardsByPaneKey: new Map([
        ['tab-1:leaf-1', card('tab-1:leaf-1', 'attention', 'waiting')],
        ['tab-2:leaf-2', card('tab-2:leaf-2', 'working', 'working')]
      ]),
      cardsByTabId: new Map(),
      attentionByPaneKey: new Map([['tab-1:leaf-1', attentionPane('tab-1:leaf-1')]])
    }
    const tree = buildSessionSidebarTree({
      sessions: [a, b],
      snapshot
    })
    expect(tree.groups[0]).toMatchObject({
      key: SESSION_ATTENTION_GROUP_KEY,
      kind: 'attention',
      attentionCount: 1
    })
    expect(tree.groups[0]?.rows[0]).toMatchObject({
      state: 'waiting',
      attention: { cause: 'waiting' }
    })
    // Why: a row is listed once — under Needs you it leaves its normal group, so the
    // remainder group holds only the working row and carries no attention badge.
    const otherGroup = tree.groups.find((group) => group.key === SESSION_OTHER_GROUP_KEY)
    expect(otherGroup?.attentionCount).toBe(0)
    expect(otherGroup?.rows.map((row) => row.session.sessionKey)).toEqual(['b'])
    const betaRow = otherGroup?.rows.find((row) => row.session.sessionKey === 'b')
    expect(betaRow?.state).toBe('working')
    expect(tree.attentionCount).toBe(1)
  })

  it('inherits tab-level attention for a row without a pane key', () => {
    const tabLevel = session({ sessionKey: null, rowKey: 'tab-row', paneKey: null, tabId: 'tab-1' })
    const tree = buildSessionSidebarTree({
      sessions: [tabLevel],
      snapshot: {
        cardsByPaneKey: new Map(),
        cardsByTabId: new Map([['tab-1', [card('tab-1:leaf-1', 'attention', 'blocked')]]]),
        attentionByPaneKey: new Map([
          ['tab-1:leaf-1', { ...attentionPane('tab-1:leaf-1'), cause: 'blocked' }]
        ])
      }
    })
    expect(tree.groups[0]?.kind).toBe('attention')
    expect(tree.groups[0]?.rows[0]?.attention?.cause).toBe('blocked')
  })

  it('searches across groups and expands every match', () => {
    const tree = buildSessionSidebarTree({
      sessions: [a, b],
      metadata: { ...emptySessionFolderMetadata(), folders: [{ id: FOLDER_ID, name: 'Later' }] },
      view: { ...emptySessionSidebarView(), collapsed: [SESSION_OTHER_GROUP_KEY] },
      query: 'beta'
    })
    expect(tree.groups.map((group) => group.key)).toEqual([SESSION_OTHER_GROUP_KEY])
    expect(tree.groups[0]?.collapsed).toBe(false)
  })
})

describe('conversations order', () => {
  it('puts what needs a person first, then what is working, then the rest; Waiting last with its count', () => {
    const done = session({
      sessionKey: 'd',
      paneKey: 'tab-4:leaf-4',
      label: 'A done one',
      tabId: 'tab-4'
    })
    const working = session({
      sessionKey: 'w',
      paneKey: 'tab-3:leaf-3',
      label: 'B working one',
      tabId: 'tab-3'
    })
    const idle = session({
      sessionKey: 'i',
      paneKey: 'tab-2:leaf-2',
      label: 'C idle one',
      tabId: 'tab-2'
    })
    const parked = session({
      sessionKey: 'p',
      paneKey: 'tab-5:leaf-5',
      label: 'D parked one',
      tabId: 'tab-5'
    })
    const snapshot = {
      cardsByPaneKey: new Map([
        ['tab-4:leaf-4', card('tab-4:leaf-4', 'done', 'done')],
        ['tab-3:leaf-3', card('tab-3:leaf-3', 'working', 'working')],
        ['tab-2:leaf-2', card('tab-2:leaf-2', 'idle', 'idle')],
        ['tab-5:leaf-5', card('tab-5:leaf-5', 'attention', 'waiting')]
      ]),
      cardsByTabId: new Map(),
      attentionByPaneKey: new Map([['tab-5:leaf-5', attentionPane('tab-5:leaf-5')]])
    }
    const tree = buildSessionSidebarTree({
      sessions: [done, idle, working, parked],
      snapshot,
      waitingUntilByPaneKey: new Map([['tab-5:leaf-5', '2999-01-01T00:00:00.000Z']])
    })
    const workspaceGroup = tree.groups.find((group) => group.kind === 'workspace')
    expect(workspaceGroup?.rows.map((row) => row.session.label)).toEqual(['B working one'])
    // Why: a finished or idle turn is Done; only the snoozed row has a wake, so only it waits.
    expect(tree.groups.some((group) => group.kind === 'attention')).toBe(false)
    const completed = tree.groups.find((group) => group.kind === 'completed')
    expect(completed).toMatchObject({ kind: 'completed', label: 'Done (2)', collapsed: true })
    expect(completed?.rows.map((row) => row.session.label)).toEqual(
      expect.arrayContaining(['C idle one', 'A done one'])
    )
    const waiting = tree.groups.find((group) => group.kind === 'waiting')
    expect(waiting).toMatchObject({ kind: 'waiting', label: 'Waiting (1)', collapsed: true })
    expect(waiting?.rows.map((row) => row.session.label)).toEqual(['D parked one'])
  })
})

describe('personal organization', () => {
  const a = session({ sessionKey: 'a', paneKey: 'tab-1:leaf-1', label: 'Alpha' })
  const b = session({
    sessionKey: 'b',
    rowKey: 'b',
    paneKey: 'tab-2:leaf-2',
    tabId: 'tab-2',
    label: 'Beta'
  })

  it('moves a personally hidden row into its own collapsed Hidden group once its tab is closed', () => {
    const tree = buildSessionSidebarTree({
      sessions: [a, { ...b, tabId: null, paneKey: null }],
      view: { ...emptySessionSidebarView(), hidden: ['conversation:b'] }
    })
    expect(
      tree.groups.map((group) => [group.key, group.rows.map((row) => row.session.label)])
    ).toEqual([
      [SESSION_OTHER_GROUP_KEY, ['Alpha']],
      ['saved-sessions', []],
      ['hidden-conversations', ['Beta']]
    ])
    expect(tree.groups.find((group) => group.kind === 'hidden')).toMatchObject({
      kind: 'hidden',
      label: 'Hidden (1)',
      collapsed: true
    })
  })

  it('keeps a hidden conversation listed while its tab is open (Sal, 2026-09-23)', () => {
    const view = { ...emptySessionSidebarView(), hidden: ['conversation:b'] }
    const open = buildSessionSidebarTree({ sessions: [a, b], view })
    expect(open.groups.find((group) => group.kind === 'hidden')).toBeUndefined()
    expect(open.groups.flatMap((group) => group.rows.map((row) => row.session.label))).toEqual([
      'Alpha',
      'Beta'
    ])
    const closed = buildSessionSidebarTree({
      sessions: [a, { ...b, tabId: null, paneKey: null }],
      view
    })
    expect(
      closed.groups.find((group) => group.kind === 'hidden')?.rows.map((row) => row.session.label)
    ).toEqual(['Beta'])
  })

  it('orders rows by the saved personal row order', () => {
    const tree = buildSessionSidebarTree({
      sessions: [a, b],
      view: { ...emptySessionSidebarView(), rowOrder: ['b', 'a'] }
    })
    expect(tree.groups[0]?.rows.map((row) => row.session.label)).toEqual(['Beta', 'Alpha'])
  })

  it('waits a pane-less row by its conversation key', () => {
    const tabLevel = session({ sessionKey: 'c', rowKey: 'c', paneKey: null })
    const tree = buildSessionSidebarTree({
      sessions: [tabLevel],
      waitingUntilByRowKey: { 'conversation:c': '2999-01-01T00:00:00.000Z' }
    })
    expect(tree.groups[0]).toMatchObject({ kind: 'waiting', label: 'Waiting (1)' })
  })

  it('files a workflow never started under Drafts, open, ahead of Waiting', () => {
    // Why: live acceptance found Build + Review drafts under a folded Waiting, as if they waited
    // on something; only a pending agent launch or a run whose state is still coming waits.
    const pane = { paneKey: null, launchPending: true } as const
    const draft = session({
      ...pane,
      sessionKey: 'draft',
      rowKey: 'draft',
      label: 'Build + Review',
      workflow: { preset: 'build-review', status: 'draft' }
    })
    const restoring = session({
      ...pane,
      sessionKey: 'restoring',
      rowKey: 'restoring',
      workflow: { preset: 'council', status: 'unknown' }
    })
    const launching = session({ ...pane, sessionKey: 'launching', rowKey: 'launching' })
    const tree = buildSessionSidebarTree({ sessions: [draft, restoring, launching] })
    // Saved Sessions is always offered as a drop target.
    expect(tree.groups.map((group) => group.kind)).toEqual(['drafts', 'waiting', 'saved'])
    expect(tree.groups[0]).toMatchObject({ key: 'drafts', label: 'Drafts (1)', collapsed: false })
    expect(tree.groups[0]?.rows.map((row) => row.session.rowKey)).toEqual(['draft'])
    expect(tree.groups[1]?.rows.map((row) => row.session.rowKey).sort()).toEqual([
      'launching',
      'restoring'
    ])
    // A group order saved before Drafts existed gives them Waiting's slot, not the end.
    const saved = buildSessionSidebarTree({
      sessions: [draft, restoring, launching],
      view: { ...emptySessionSidebarView(), order: ['waiting'] }
    })
    expect(saved.groups.map((group) => group.kind)).toEqual(['drafts', 'waiting', 'saved'])
  })
})

describe('a plan that ended with Back to me', () => {
  const now = 1_000_000_000
  it('puts the source row under Needs you until it is opened', () => {
    const row = session({ rowKey: 'row' })
    const snapshot = emptySnapshot()
    snapshot.cardsByPaneKey.set(row.paneKey!, {
      ...card(row.paneKey!, 'done', 'done'),
      stateChangedAt: now - 60_000
    })
    const tree = buildSessionSidebarTree({
      now,
      sessions: [row],
      snapshot,
      returnedByPaneKey: new Map([[row.paneKey!, now - 30_000]])
    })
    expect(tree.groups[0]).toMatchObject({ key: SESSION_ATTENTION_GROUP_KEY, attentionCount: 1 })
    expect(tree.groups[0]?.rows[0]?.returned).toBe(true)
    expect(tree.attentionCount).toBe(1)
  })
  // Why: work that started again after the plan ended is live work, not a waiting result.
  it('ignores a mark older than the pane own last state change', () => {
    const row = session({ rowKey: 'row' })
    const snapshot = emptySnapshot()
    snapshot.cardsByPaneKey.set(row.paneKey!, {
      ...card(row.paneKey!, 'working', 'working'),
      stateChangedAt: now - 10_000
    })
    const tree = buildSessionSidebarTree({
      now,
      sessions: [row],
      snapshot,
      returnedByPaneKey: new Map([[row.paneKey!, now - 30_000]])
    })
    expect(tree.groups[0]?.key).not.toBe(SESSION_ATTENTION_GROUP_KEY)
    expect(tree.groups[0]?.rows[0]?.returned).toBeFalsy()
  })
})

describe('retention groups', () => {
  const now = 1_000_000_000
  const chain = normalizeSessionChain({
    id: 'chain',
    sourceRowKey: 'row',
    sourcePaneKey: 'pane',
    workspacePath: '/work',
    worktreeId: 'w1',
    hostId: null,
    auto: true,
    steps: [{ id: 'step', agent: 'claude', prompt: 'Review', status: 'queued' }],
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: now
  })!
  const handoff = normalizeSessionChain({
    ...chain,
    state: 'done',
    steps: [
      {
        kind: 'handoff',
        id: 'handoff',
        status: 'delivered',
        handoff: {
          revision: 1,
          taskId: null,
          taskTitle: 'Review',
          sessionLabel: 'Review',
          recipients: [
            {
              employeeId: 'emp_uma',
              name: 'Uma',
              operationId: 'operation',
              delivery: 'sent',
              threadId: 'hth_12345678'
            }
          ],
          deliverables: { kind: 'files', paths: ['/result'] },
          includeSummary: true,
          note: 'Review',
          savedAt: 1
        }
      }
    ]
  })!
  it.each([9, 11, 601])('reads an unverified turn end as Done at age %s minutes', (age) => {
    const row = session({})
    const snapshot = emptySnapshot()
    snapshot.cardsByPaneKey.set(row.paneKey!, {
      ...card(row.paneKey!, 'done', 'done'),
      stateChangedAt: now - age * 60_000
    })
    const input = { now, sessions: [row], snapshot }
    const tree = buildSessionSidebarTree(input)
    expect(tree.groups.map((group) => group.kind)).toEqual(['completed', 'saved'])
    expect(tree.groups[0]).toMatchObject({ label: 'Done (1)', collapsed: true })
    expect(tree.groups[0]?.rows[0]?.completed).toEqual({
      reason: 'finished',
      at: now - age * 60_000
    })
    expect(tree.archivedCount).toBe(0)
    expect(buildSessionSidebarTree({ ...input, query: 'landing' }).groups[0]).toMatchObject({
      kind: 'completed',
      collapsed: false
    })
  })
  it.each([
    [chain, 'waiting', null],
    // Why: a plan that could not go on is an honest failure in plain sight; nobody was asked.
    [{ ...chain, state: 'failed' }, 'stopped', null],
    // Why: a plan that waits on a pane's own question is in front of the person.
    [{ ...chain, blocked: { paneKey: 'pane', reason: 'waiting' } }, 'attention', null],
    // A handed-off plan waits on its recipient; an ended legacy plan cannot verify its pane.
    [handoff, 'waiting', null],
    [{ ...chain, state: 'done', end: 'done' }, 'waiting', null]
  ] as const)('classifies plan %#', (chain, kind, reason) => {
    const tree = buildSessionSidebarTree({
      now,
      sessions: [session({ rowKey: 'row' })],
      chainByRowKey: new Map([['row', chain]])
    })
    expect(tree.groups[0]?.kind).toBe(kind)
    const row = tree.groups[0]!.rows[0]!
    expect(row.completed?.reason ?? null).toBe(reason)
    expect(!!row.locked).toBe(kind === 'waiting' && chain.state === 'waiting')
  })
  it('lists a plan that needs the person under Needs you only, not in its own group', () => {
    const tree = buildSessionSidebarTree({
      now,
      sessions: [session({ rowKey: 'row' })],
      chainByRowKey: new Map([
        ['row', { ...chain, blocked: { paneKey: 'pane', reason: 'waiting' } }]
      ])
    })
    expect(tree.groups.map((group) => [group.kind, group.label])).toEqual([
      ['attention', 'Needs you'],
      ['saved', 'Saved Sessions']
    ])
    expect(tree.groups[0]?.rows[0]?.planNeedsYou).toBe(true)
    expect(tree.attentionCount).toBe(1)
  })
  it('keeps a failed plan in Stopped, out of Needs you and out of every count', () => {
    const tree = buildSessionSidebarTree({
      now,
      sessions: [session({ rowKey: 'row' })],
      chainByRowKey: new Map([['row', { ...chain, state: 'failed' as const }]])
    })
    expect(tree.groups.map((group) => group.kind)).toEqual(['stopped', 'saved'])
    expect(tree.groups[0]?.rows[0]).toMatchObject({ planNeedsYou: false, state: 'failed' })
    expect(tree.groups[0]?.attentionCount).toBe(0)
    expect(tree.attentionCount).toBe(0)
  })
  it('keeps a failed plan out of Needs you while the session works again', () => {
    const row = session({ rowKey: 'row' })
    const snapshot = emptySnapshot()
    snapshot.cardsByPaneKey.set(row.paneKey!, {
      ...card(row.paneKey!, 'working', 'working'),
      stateChangedAt: now + 1
    })
    const tree = buildSessionSidebarTree({
      now,
      sessions: [row],
      snapshot,
      chainByRowKey: new Map([['row', { ...chain, state: 'failed' as const }]])
    })
    expect(tree.groups.map((group) => group.kind)).toEqual(['workspace', 'saved'])
    expect(tree.groups[0]?.rows[0]?.planNeedsYou).toBe(false)
  })
})

describe('shared session organization', () => {
  it('keeps a snoozed session in its chosen folder before and after its return time', () => {
    const item = session({ sessionKey: 'snoozed' })
    const metadata = moveSessionToFolder(
      { ...emptySessionFolderMetadata(), folders: [{ id: FOLDER_ID, name: 'Project' }] },
      'snoozed',
      FOLDER_ID
    )
    const input = {
      sessions: [item],
      metadata,
      view: { ...emptySessionSidebarView(), snoozedUntil: { snoozed: 60_000 } }
    }
    expect(
      buildSessionSidebarTree({ ...input, now: 59_999, snapshot: emptySnapshot() }).groups.find(
        (group) => group.folder?.id === FOLDER_ID
      )?.rows[0]?.session
    ).toEqual(item)
    expect(
      buildSessionSidebarTree({ ...input, now: 60_000 }).groups.find(
        (group) => group.folder?.id === FOLDER_ID
      )?.rows[0]?.session
    ).toEqual(item)
  })

  it('explicit archive is reversible and does not alter folder membership', () => {
    const item = session({ sessionKey: 'archived' })
    const input = {
      sessions: [item],
      view: { ...emptySessionSidebarView(), archived: ['archived'] }
    }
    expect(buildSessionSidebarTree(input).archivedCount).toBe(1)
    expect(
      buildSessionSidebarTree({ ...input, showArchived: true }).groups.find(
        (group) => group.kind === 'archived'
      )?.rows[0]?.session
    ).toEqual(item)
    expect(
      buildSessionSidebarTree({ ...input, view: emptySessionSidebarView() }).groups.flatMap(
        (group) => group.rows
      )
    ).toHaveLength(1)
  })

  it('honors hides made in the older technical Sessions view', () => {
    const item = session({ sessionKey: 'legacy', tabId: null, paneKey: null })
    const tree = buildSessionSidebarTree({
      sessions: [item],
      view: { ...emptySessionSidebarView(), hidden: ['session:legacy'] }
    })
    expect(
      tree.groups.filter((group) => group.kind !== 'hidden').flatMap((group) => group.rows)
    ).toHaveLength(0)
    expect(tree.groups.find((group) => group.kind === 'hidden')?.rows[0]?.session).toEqual(item)
  })
})
