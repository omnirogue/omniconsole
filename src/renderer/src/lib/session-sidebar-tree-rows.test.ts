import { describe, expect, it } from 'vitest'
import type { AttentionPane } from '@/components/attention/agent-pane-snapshot'
import type { HumanAttentionRequest } from '../../../shared/session-human-attention'
import { conversationPlanFixture } from './conversation-plan-fixture'
import { buildSessionSidebarTree } from './session-sidebar-tree'
import { buildSessionSidebarTreeRows } from './session-sidebar-tree-rows'
import { emptySessionFolderMetadata, SAVED_SESSIONS_FOLDER_ID } from './session-folders'
import { emptySessionSidebarView } from './session-sidebar-view'
import type { SidebarSession } from './sidebar-sessions'

function session(key: string, tabId: string): SidebarSession {
  return {
    rowKey: key,
    sessionKey: key,
    worktreeId: 'folder:1',
    hostId: 'local',
    tabId,
    paneKey: `${tabId}:leaf-1`,
    kind: 'terminal',
    label: key,
    workspaceLabel: 'Workspace',
    agent: 'claude',
    unavailable: false,
    folderKeyMigration: null
  }
}
const sessions = [
  session('source', 'source'),
  ...[1, 2, 3].map((index) => session(`seat${index}`, `worker-task${index}`))
]
const input = () => ({
  sessions,
  metadata: emptySessionFolderMetadata(),
  view: emptySessionSidebarView(),
  snapshot: { cardsByPaneKey: new Map(), cardsByTabId: new Map(), attentionByPaneKey: new Map() },
  query: '',
  showHidden: false
})

describe('folded pursuit seat rows', () => {
  it('keeps one source row with three collapsed children for a live plan', () => {
    const chain = conversationPlanFixture()
    chain.outcomeSet!.attempts.forEach((attempt) => {
      attempt.state = 'running'
    })
    const result = buildSessionSidebarTreeRows(
      { ...input(), chainByRowKey: new Map([['source', chain]]) },
      10
    )
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ pursuitState: 'running', childrenCollapsed: true })
    expect(result.rows[0]!.children?.map((row) => row.session.rowKey)).toEqual([
      'seat1',
      'seat2',
      'seat3'
    ])
  })

  it("leaves chainless conversations at top level and keeps a finished plan's seats as its workers", () => {
    expect(buildSessionSidebarTreeRows(input(), 10).rows.map((row) => row.session)).toEqual(
      sessions
    )
    const chain = conversationPlanFixture()
    chain.state = 'done'
    const finished = buildSessionSidebarTreeRows(
      { ...input(), chainByRowKey: new Map([['source', chain]]) },
      10
    )
    expect(finished.rows.map((row) => row.session.rowKey)).toEqual(['source'])
    expect(finished.rows[0]!.workers).toMatchObject({ count: 3, expanded: false })
    expect(finished.workersByRowKey.get('source')?.map((row) => row.session.rowKey)).toEqual([
      'seat1',
      'seat2',
      'seat3'
    ])
  })

  it('never folds another host or workspace, or hides a seat without its source', () => {
    const chain = conversationPlanFixture()
    const remote = { ...sessions[1]!, rowKey: 'remote', hostId: 'ssh:other' as const }
    const result = buildSessionSidebarTreeRows(
      { ...input(), sessions: [...sessions, remote], chainByRowKey: new Map([['source', chain]]) },
      10
    )
    expect(result.rows.map((row) => row.session.rowKey)).toEqual(['source', 'remote'])
    expect(
      buildSessionSidebarTreeRows(
        { ...input(), sessions: sessions.slice(1), chainByRowKey: new Map([['source', chain]]) },
        10
      ).rows
    ).toHaveLength(3)
  })
})

const STALL = 'No activity was observed for 180s. The worker may have stalled.'

function stalledPlan() {
  const chain = conversationPlanFixture()
  chain.outcomeSet!.attempts.forEach((attempt) => {
    attempt.state = 'blocked'
    attempt.error = STALL
  })
  chain.outcomeSet!.outcomes[0]!.status = 'blocked'
  chain.outcomeSet!.outcomes[0]!.blockedReason = STALL
  return chain
}

function ownerRequest(patch: Partial<HumanAttentionRequest> = {}): HumanAttentionRequest {
  return {
    id: 'att_agent-prompt_attempt1_1',
    kind: 'clarification',
    scope: { outcomeId: 'outcome', outcomeRevision: 1, attemptId: 'attempt1' },
    ask: "Answer claude's question: which branch?",
    why: 'claude cannot choose this for you and is waiting for your answer.',
    recipient: { type: 'owner' },
    action: { kind: 'open-conversation', label: 'Answer', paneKey: 'worker-task1:leaf-1' },
    source: { type: 'agent-prompt', ref: 'which branch?' },
    state: 'open',
    openedAt: 5,
    ...patch
  }
}

function stoppedPane(paneKey: string): AttentionPane {
  return {
    paneKey,
    portalPaneKey: paneKey,
    worktreeId: 'folder:1',
    tabId: paneKey.split(':')[0]!,
    leafId: 'leaf-1',
    agentType: 'claude',
    bucket: 'attention',
    dotState: 'waiting',
    cause: 'waiting',
    unseen: false,
    title: 'task',
    stateChangedAt: 5,
    repoName: 'Website',
    worktreeName: 'main'
  }
}

describe('plan rows read the one run classifier', () => {
  const rowsFor = (chain: ReturnType<typeof conversationPlanFixture>, extra = {}) =>
    buildSessionSidebarTreeRows(
      { ...input(), ...extra, chainByRowKey: new Map([['source', chain]]) },
      10
    )

  it('reads the 180 s stall as Failed: outside Needs you, uncounted, seats failed too', () => {
    // Why: even the source pane sitting idle in the "needs you" list is not the person's move.
    const result = rowsFor(stalledPlan(), {
      snapshot: {
        cardsByPaneKey: new Map(),
        cardsByTabId: new Map(),
        attentionByPaneKey: new Map([['source:leaf-1', stoppedPane('source:leaf-1')]])
      }
    })
    expect(result.classifications.get('source')).toBe('stopped')
    expect(result.rows[0]).toMatchObject({
      pursuitState: 'failed',
      planNeedsYou: false,
      attention: null,
      returned: false,
      locked: null,
      run: { phase: 'failed', countsAsAttention: false, requests: [] }
    })
    expect(result.rows[0]!.children?.map((seat) => seat.pursuitState)).toEqual([
      'failed',
      'failed',
      'failed'
    ])
    const tree = buildSessionSidebarTree({
      ...input(),
      now: 10,
      chainByRowKey: new Map([['source', stalledPlan()]])
    })
    expect(tree.attentionCount).toBe(0)
    expect(tree.groups.map((group) => group.kind)).not.toContain('attention')
  })

  it('keeps a working sibling Active and counts its open owner request once', () => {
    const chain = conversationPlanFixture()
    chain.outcomeSet!.attention = [ownerRequest()]
    const result = rowsFor(chain)
    expect(result.classifications.get('source')).toBe('conversations')
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      pursuitState: 'running',
      planNeedsYou: true,
      locked: null,
      run: {
        countsAsAttention: true,
        headline: "Needs you: Answer claude's question: which branch?"
      }
    })
    // Why: the seat whose attempt asked reads as asking; the row is still counted once.
    expect(result.rows[0]!.children?.map((seat) => seat.pursuitState)).toEqual([
      'needs-you',
      'running',
      'queued'
    ])
    const build = () =>
      buildSessionSidebarTree({
        ...input(),
        now: 10,
        chainByRowKey: new Map([['source', chain]])
      })
    expect(build().attentionCount).toBe(1)
    expect(build().groups[0]).toMatchObject({ kind: 'workspace', attentionCount: 1 })
    // Why: a reconnect rebuilds the tree from the same record; the request is not counted again.
    chain.outcomeSet!.continuation.state = 'unverifiable'
    expect(build().attentionCount).toBe(1)
    chain.outcomeSet!.continuation.state = 'owned'
    expect(build().attentionCount).toBe(1)
  })

  it("never lists a run's request a second time on a worker's own row", () => {
    const chain = conversationPlanFixture()
    chain.state = 'done'
    const listed = {
      ...stoppedPane('worker-task1:leaf-1'),
      run: {
        chainId: 'other',
        sourceRowKey: 'elsewhere',
        headline: 'Needs you: Answer.',
        why: 'Only you can.',
        requests: [ownerRequest()]
      }
    }
    const result = rowsFor(chain, {
      snapshot: {
        cardsByPaneKey: new Map(),
        cardsByTabId: new Map(),
        attentionByPaneKey: new Map([['worker-task1:leaf-1', listed]])
      }
    })
    // A finished plan keeps its seats as workers under its row.
    const seats = [...result.rows, ...(result.workersByRowKey.get('source') ?? [])]
    expect(seats.find((row) => row.session.rowKey === 'seat1')).toMatchObject({
      attention: null
    })
    expect(result.classifications.get('seat1')).not.toBe('attention')
  })

  it('reads an unproven legacy seal as finished without fabricating an owner request', () => {
    const chain = stalledPlan()
    // Why: the host has not written `done` yet, contact is lost and an old attempt is blocked.
    // The seal is final and waits on nobody, so the row is Done — "finished", never "complete".
    chain.outcomeSet!.completion = {
      at: 4,
      outcomes: [{ id: 'outcome', revision: 1 }],
      evidenceIds: []
    }
    chain.outcomeSet!.continuation.state = 'unverifiable'
    chain.outcomeSet!.attention = [ownerRequest()]
    const result = rowsFor(chain)
    expect(result.classifications.get('source')).toBe('completed')
    expect(result.rows.find((row) => row.session.rowKey === 'source')).toMatchObject({
      pursuitState: 'done',
      planNeedsYou: false,
      attention: null,
      locked: null,
      completed: { reason: 'finished' },
      run: { phase: 'completed', countsAsAttention: false, requests: [] }
    })
    const tree = buildSessionSidebarTree({
      ...input(),
      now: 10,
      chainByRowKey: new Map([['source', chain]])
    })
    expect(tree.attentionCount).toBe(0)
    const kinds = tree.groups.filter((group) =>
      group.rows.some((row) => row.session.rowKey === 'source')
    )
    expect(kinds.map((group) => group.kind)).toEqual(['completed'])
  })

  it('reads an unproven Back to me ending as Done for the person', () => {
    const chain = conversationPlanFixture()
    chain.state = 'done'
    chain.end = 'me'
    const result = rowsFor(chain)
    expect(result.classifications.get('source')).toBe('completed')
    expect(result.rows.find((row) => row.session.rowKey === 'source')).toMatchObject({
      pursuitState: 'done',
      planNeedsYou: false,
      completed: { reason: 'finished' }
    })
  })

  it('waits on a named person without counting for the owner', () => {
    const chain = conversationPlanFixture()
    chain.outcomeSet!.attempts = []
    chain.outcomeSet!.outcomes[0]!.status = 'blocked'
    chain.outcomeSet!.outcomes[0]!.block = { class: 'waiting', code: 'person-review', since: 1 }
    chain.outcomeSet!.attention = [
      ownerRequest({
        scope: { outcomeId: 'outcome', outcomeRevision: 1 },
        recipient: { type: 'person', employeeId: 'emp_uma', name: 'Uma' }
      })
    ]
    const result = rowsFor(chain)
    expect(result.classifications.get('source')).toBe('waiting')
    expect(result.rows[0]).toMatchObject({
      pursuitState: 'awaiting',
      planNeedsYou: false,
      run: { phase: 'waiting', headline: 'Waiting for Uma', countsAsAttention: false }
    })
  })
})

describe('a Stalled session', () => {
  it('joins Needs you while the steward lists it, and leaves it once it no longer does', () => {
    const classify = (stalled: ReadonlySet<string>) =>
      buildSessionSidebarTreeRows({ ...input(), stalledPaneKeys: stalled }, 10).classifications
    expect(classify(new Set(['source:leaf-1'])).get('source')).toBe('attention')
    expect(classify(new Set()).get('source')).not.toBe('attention')
  })
})

describe('saved sessions with current activity', () => {
  it.each([
    ['running', 'conversations'],
    ['needs-you', 'attention'],
    ['unknown', 'waiting'],
    ['done', 'saved'],
    ['draft', 'saved']
  ] as const)('surfaces a saved workflow reporting %s in %s', (status, expected) => {
    const row: SidebarSession = {
      ...session('source', 'source'),
      paneKey: null,
      launchPending: status === 'unknown' || status === 'draft',
      workflow: { preset: 'discover', status }
    }
    const result = buildSessionSidebarTreeRows(
      {
        ...input(),
        sessions: [row],
        metadata: {
          ...emptySessionFolderMetadata(),
          membership: { source: SAVED_SESSIONS_FOLDER_ID }
        }
      },
      10
    )
    expect(result.classifications.get('source')).toBe(expected)
  })

  it('keeps a saved pane visible while its latest execution cannot be verified', () => {
    const card = {
      ...stoppedPane('source:leaf-1'),
      bucket: 'idle' as const,
      dotState: 'idle' as const,
      activityUnverifiable: true
    }
    const result = buildSessionSidebarTreeRows(
      {
        ...input(),
        metadata: {
          ...emptySessionFolderMetadata(),
          membership: { source: SAVED_SESSIONS_FOLDER_ID }
        },
        snapshot: {
          cardsByPaneKey: new Map([[card.paneKey, card]]),
          cardsByTabId: new Map(),
          attentionByPaneKey: new Map()
        }
      },
      10
    )
    expect(result.classifications.get('source')).toBe('waiting')
  })
})
