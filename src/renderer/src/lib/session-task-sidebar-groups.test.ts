import { describe, expect, it } from 'vitest'
import type { AttentionPane } from '@/components/attention/agent-pane-snapshot'
import type { SessionSidebarGroup, SessionSidebarTreeRow } from './session-sidebar-tree'
import {
  emptySessionSidebarView,
  isSessionGroupCollapsed,
  setSessionGroupsCollapsed
} from './session-sidebar-view'
import {
  addSessionTaskGroups,
  sessionTaskGroupKey,
  sessionTaskRowState,
  sessionTaskRef,
  taskGroupFallbackLabel
} from './session-task-sidebar-groups'
import type { SidebarSession } from './sidebar-sessions'
import { sessionRunRowState } from './session-run-row-state'
import type { SessionChain } from '../../../shared/session-chain-types'

function session(id: string): SidebarSession {
  return {
    rowKey: `row-${id}`,
    sessionKey: `session-${id}`,
    worktreeId: 'w1',
    hostId: 'local',
    tabId: `tab-${id}`,
    paneKey: `tab-${id}:leaf`,
    kind: 'terminal',
    label: `Session ${id}`,
    workspaceLabel: 'Website',
    agent: 'codex',
    unavailable: false,
    folderKeyMigration: null
  }
}

function row(id: string, overrides: Partial<SessionSidebarTreeRow> = {}): SessionSidebarTreeRow {
  return {
    session: session(id),
    folderId: null,
    attention: null,
    state: null,
    waitingUntil: null,
    ...overrides
  }
}

function group(
  key: string,
  kind: SessionSidebarGroup['kind'],
  rows: SessionSidebarTreeRow[]
): SessionSidebarGroup {
  return {
    key,
    kind,
    label: key,
    rows,
    collapsed: false,
    hidden: false,
    attentionCount: 0,
    canReorder: false,
    canHide: false
  }
}

const TASK = 'btk_launch1'

describe('group by task', () => {
  it('folds tasked rows from Active, Waiting and Done into one counted task group after Needs you', () => {
    const asking = row('a', { attention: { cause: 'waiting' } as AttentionPane })
    const groups = [
      group('attention', 'attention', [asking]),
      group('workspace:other', 'workspace', [
        asking,
        row('b', { state: 'working' }),
        row('c', { state: 'idle' }),
        row('free')
      ]),
      group('waiting', 'waiting', [row('d')]),
      group('completed', 'completed', [row('e', { state: 'done' })])
    ]
    const tasked = new Set(['a', 'b', 'c', 'd', 'e'].map((id) => `tab-${id}:leaf`))
    const result = addSessionTaskGroups({
      groups,
      taskFor: (entry) =>
        tasked.has(entry.paneKey!) ? { taskId: TASK, title: 'Launch the site' } : null,
      view: emptySessionSidebarView(),
      query: ''
    })
    expect(result.map((entry) => entry.key)).toEqual([
      'attention',
      sessionTaskGroupKey(TASK),
      'workspace:other'
    ])
    const task = result[1]!
    expect(task).toMatchObject({ kind: 'task', label: 'Launch the site', collapsed: true })
    expect(task.rows.map((entry) => entry.session.rowKey)).toEqual([
      'row-a',
      'row-b',
      'row-c',
      'row-d',
      'row-e'
    ])
    expect(task.taskCounts).toEqual({ needsYou: 1, running: 1, waiting: 2, done: 1 })
    // Why: Needs you keeps its copy; only un-tasked rows stay in Active.
    expect(result[0]!.rows).toEqual([asking])
    expect(result[2]!.rows.map((entry) => entry.session.rowKey)).toEqual(['row-free'])
  })

  it('folds a tasked draft into its task group and drops the Drafts group it empties', () => {
    // Why: drafts used to sit in Waiting, which group by task folds; Drafts folds the same way.
    const result = addSessionTaskGroups({
      groups: [
        group('drafts', 'drafts', [row('a')]),
        group('waiting', 'waiting', [row('b'), row('free')])
      ],
      taskFor: (entry) =>
        entry.rowKey === 'row-free' ? null : { taskId: TASK, title: 'Launch the site' },
      view: emptySessionSidebarView(),
      query: ''
    })
    expect(result.map((entry) => entry.key)).toEqual([sessionTaskGroupKey(TASK), 'waiting'])
    expect(result[0]!.rows.map((entry) => entry.session.rowKey)).toEqual(['row-a', 'row-b'])
    expect(result[1]).toMatchObject({ label: 'Waiting (1)' })
  })

  it('counts a snoozed conversation as waiting, never as running', () => {
    const [task] = addSessionTaskGroups({
      groups: [
        group('waiting', 'waiting', [
          row('a', { state: 'working', waitingUntil: '2026-09-16T09:00:00.000Z' })
        ])
      ],
      taskFor: () => ({ taskId: TASK, title: 'Launch the site' }),
      view: emptySessionSidebarView(),
      query: ''
    })
    expect(task!.taskCounts).toEqual({ needsYou: 0, running: 0, waiting: 1, done: 0 })
  })

  it('leaves the tree untouched when no row has a task, and opens a task group once expanded', () => {
    const groups = [group('workspace:other', 'workspace', [row('a')])]
    const view = emptySessionSidebarView()
    expect(addSessionTaskGroups({ groups, taskFor: () => null, view, query: '' })).toEqual(groups)
    const key = sessionTaskGroupKey(TASK)
    expect(isSessionGroupCollapsed(view, key)).toBe(true)
    const opened = setSessionGroupsCollapsed(view, [key], false)
    expect(isSessionGroupCollapsed(opened, key)).toBe(false)
    const [task] = addSessionTaskGroups({
      groups,
      taskFor: () => ({ taskId: TASK }),
      view: opened,
      query: ''
    })
    expect(task).toMatchObject({ key, collapsed: false })
  })

  it('reads a task known only by card id as a task, and takes the title as soon as one row has it', () => {
    const groups = [group('workspace:other', 'workspace', [row('a'), row('b')])]
    const untitled = addSessionTaskGroups({
      groups,
      taskFor: () => ({ taskId: TASK }),
      view: emptySessionSidebarView(),
      query: ''
    })
    // Why: a raw btk_ id in the sidebar heading tells the person nothing about the work.
    expect(untitled[0]!.label).toBe(taskGroupFallbackLabel(TASK))
    expect(untitled[0]!.label).toContain(TASK)
    const titled = addSessionTaskGroups({
      groups,
      taskFor: (entry) =>
        entry.paneKey === 'tab-b:leaf'
          ? { taskId: TASK, title: 'Launch the site' }
          : { taskId: TASK },
      view: emptySessionSidebarView(),
      query: ''
    })
    expect(titled[0]!.label).toBe('Launch the site')
  })

  it('reads the task from the device link first, then from the ledger card of the pane', () => {
    const linked = session('a')
    const ledgerOnly = session('b')
    const links = { [linked.paneKey!]: { taskId: TASK, title: 'Launch the site' } }
    const ledger = new Map([[ledgerOnly.paneKey!, 'btk_ledger1']])
    expect(sessionTaskRef(linked, links, ledger)).toEqual({
      taskId: TASK,
      title: 'Launch the site'
    })
    expect(sessionTaskRef(ledgerOnly, links, ledger)).toEqual({ taskId: 'btk_ledger1' })
    expect(sessionTaskRef(session('c'), links, ledger)).toBeNull()
  })
})

it('feeds outcome counts into the existing task group when chains are supplied', async () => {
  const { planReportChain } =
    await import('../../../shared/__fixtures__/work-plan/plan-report-chain')
  const chain = planReportChain()
  chain.outcomeSet!.continuation.taskId = TASK
  const [task] = addSessionTaskGroups({
    groups: [group('workspace:w1', 'workspace', [row('a')])],
    taskFor: () => ({ taskId: TASK }),
    view: emptySessionSidebarView(),
    query: '',
    chains: [chain]
  })
  expect(task!.taskCounts!.outcomes).toEqual({ satisfied: 0, total: 1 })
})

describe('task counts read a plan row through its run', () => {
  const now = 1_000_000_000
  const counted = async (patch: (chain: SessionChain) => void) => {
    const { conversationPlanFixture } = await import('./conversation-plan-fixture')
    const chain = conversationPlanFixture()
    chain.outcomeSet!.attempts = []
    patch(chain)
    const run = sessionRunRowState(chain, { now })
    const [task] = addSessionTaskGroups({
      groups: [
        group('workspace:w1', 'workspace', [
          row('a', { state: 'failed', run, planNeedsYou: run.countsAsAttention })
        ])
      ],
      taskFor: () => ({ taskId: TASK }),
      view: emptySessionSidebarView(),
      query: ''
    })
    return { counts: task!.taskCounts!, attention: task!.attentionCount }
  }

  it('never counts a blocked or failed plan as needing the person', async () => {
    const { counts, attention } = await counted((chain) => {
      chain.outcomeSet!.outcomes[0]!.status = 'blocked'
      chain.outcomeSet!.outcomes[0]!.blockedReason = 'No activity was observed for 180s.'
    })
    expect(counts).toMatchObject({ needsYou: 0, waiting: 1, running: 0, done: 0 })
    expect(attention).toBe(0)
  })

  it('counts a plan with an open request once', async () => {
    const { counts, attention } = await counted((chain) => {
      chain.outcomeSet!.attention = [
        {
          id: 'att_review-findings_outcome_1',
          kind: 'decision',
          scope: { outcomeId: 'outcome', outcomeRevision: 1 },
          ask: 'Decide what happens to 2 open review findings.',
          why: 'All 2 authorized review rounds are used; another one needs your say.',
          recipient: { type: 'owner' },
          source: { type: 'review-findings', ref: 'rounds:2' },
          state: 'open',
          openedAt: 5
        }
      ]
    })
    expect(counts).toMatchObject({ needsYou: 1, waiting: 0, running: 0, done: 0 })
    expect(attention).toBe(1)
  })

  it('counts a sealed plan as done whatever its pane last said', async () => {
    const { counts, attention } = await counted((chain) => {
      chain.outcomeSet!.completion = {
        at: 50,
        outcomes: [{ id: 'outcome', revision: 1 }],
        evidenceIds: []
      }
      chain.outcomeSet!.continuation.state = 'unverifiable'
    })
    expect(counts).toMatchObject({ needsYou: 0, waiting: 0, running: 0, done: 1 })
    expect(attention).toBe(0)
  })
})

it.each([
  ['working', 'running'],
  ['queued', 'waiting'],
  ['awaiting', 'waiting'],
  ['unverifiable', 'waiting'],
  ['needs-you', 'needsYou'],
  ['done', 'done']
] as const)(
  'counts %s consistently when the source pane previously finished',
  (pursuitState, expected) => {
    expect(sessionTaskRowState(row('resumed', { state: 'done', pursuitState }), 'waiting')).toBe(
      expected
    )
  }
)
