import { describe, expect, it } from 'vitest'
import { EMPTY_AGENT_PANE_SNAPSHOT } from '@/components/attention/agent-pane-snapshot'
import type { ConversationFleetView } from '@/store/conversation-fleet-store'
import type { ConsoleWorkflowJob } from '../../../shared/console-workflow-types'
import {
  addConversationFleetGroups,
  conversationFleetRowKey,
  conversationFleetSource,
  isConversationFleetRowHidden,
  sessionsOutsideFleet
} from './conversation-fleet-sidebar'
import { buildSessionSidebarTree } from './session-sidebar-tree'
import { emptySessionFolderMetadata } from './session-folders'
import { emptySessionSidebarView, setSessionGroupsCollapsed } from './session-sidebar-view'
import type { SidebarSession } from './sidebar-sessions'

const source: SidebarSession = {
  rowKey: 'source-row',
  sessionKey: 'source-session',
  worktreeId: 'workspace',
  hostId: 'local',
  tabId: 'tab',
  paneKey: 'tab:leaf',
  kind: 'terminal',
  label: 'Build landing page',
  workspaceLabel: 'Website / main',
  agent: 'codex',
  unavailable: false,
  folderKeyMigration: null
}

const closedSource: SidebarSession = { ...source, tabId: null, paneKey: null }

function run(overrides: Partial<ConversationFleetView> = {}): ConversationFleetView {
  return {
    workflowId: 'wf_12345678',
    taskId: 'btk_12345678',
    rowKey: source.rowKey,
    sessionKey: source.sessionKey,
    title: source.label,
    createdAt: '2026-09-12T14:00:00.000Z',
    capturedAt: '2026-09-12T13:50:00.000Z',
    machine: 'mw0002',
    jobs: [{ id: 'job_12345678', status: 'running' } as ConsoleWorkflowJob],
    admission: 'accepted',
    verified: true,
    error: null,
    ...overrides
  }
}

function project(runs: ConversationFleetView[], sessions: SidebarSession[] = [], query = '') {
  const view = emptySessionSidebarView()
  const tree = buildSessionSidebarTree({
    sessions: sessionsOutsideFleet(sessions, runs),
    metadata: emptySessionFolderMetadata(),
    view,
    snapshot: EMPTY_AGENT_PANE_SNAPSHOT,
    query,
    showHidden: false
  })
  return addConversationFleetGroups({ groups: tree.groups, sessions, runs, view, query })
}

describe('fleet conversation sidebar', () => {
  it('removes deleted archive receipts while preserving a source that has reopened', () => {
    const receipt = run()
    const key = conversationFleetRowKey(receipt, closedSource)
    const args = {
      groups: [],
      runs: [receipt],
      query: '',
      showArchived: true,
      view: { ...emptySessionSidebarView(), archived: [key], deleted: [key] }
    }
    expect(addConversationFleetGroups({ ...args, sessions: [closedSource] })).toEqual([])
    expect(addConversationFleetGroups({ ...args, sessions: [source] })[0].fleetRows).toHaveLength(1)
    const orphanKey = conversationFleetRowKey(receipt, null)
    expect(
      addConversationFleetGroups({
        ...args,
        sessions: [],
        view: {
          ...args.view,
          archived: [orphanKey],
          deleted: [orphanKey]
        }
      })
    ).toEqual([])
  })

  it('replaces an admitted source with one Active receipt while preserving its source action', () => {
    const groups = project([run()], [source])
    expect(groups.map((group) => group.key)).toEqual(['workspace:other', 'saved-sessions'])
    expect(groups[0]).toMatchObject({ rows: [], collapsed: false, fleetRows: [{ source }] })
    expect(sessionsOutsideFleet([{ ...source, rowKey: 'restored-row' }], [run()])).toEqual([])
    const replacement = { ...source, sessionKey: 'new-provider-session' }
    expect(sessionsOutsideFleet([replacement], [run()])).toEqual([replacement])
    expect(
      project([run()], [replacement]).find((group) => group.kind === 'workspace')?.fleetRows[0]
        .source
    ).toBeNull()
  })

  it('keeps accepted work Waiting on contact loss, including when its source tab is gone', () => {
    const receipt = run({ verified: false, error: 'Connection lost' })
    expect(project([receipt], [source])[0]).toMatchObject({
      key: 'waiting',
      fleetRows: [{ run: { verified: false, error: 'Connection lost' } }]
    })
    expect(project([receipt])[0].fleetRows[0].source).toBeNull()
  })

  it('does not conceal a turn or attention request that starts between capture and admission', () => {
    const receipt = run()
    for (const bucket of ['working', 'attention'] as const) {
      const snapshot = {
        ...EMPTY_AGENT_PANE_SNAPSHOT,
        cardsByPaneKey: new Map([
          [
            source.paneKey!,
            {
              paneKey: source.paneKey!,
              worktreeId: source.worktreeId,
              tabId: source.tabId!,
              leafId: 'leaf',
              agentType: 'codex' as const,
              bucket,
              dotState: 'working' as const,
              unseen: false,
              title: source.label,
              stateChangedAt: Date.parse(receipt.capturedAt!) + 1,
              repoName: 'Website',
              worktreeName: 'main'
            }
          ]
        ])
      }
      expect(sessionsOutsideFleet([source], [receipt], snapshot)).toEqual([source])
      expect(sessionsOutsideFleet([source], [run({ capturedAt: undefined })], snapshot)).toEqual([
        source
      ])
      snapshot.cardsByPaneKey.get(source.paneKey!)!.stateChangedAt =
        Date.parse(receipt.capturedAt!) - 1
      expect(sessionsOutsideFleet([source], [receipt], snapshot)).toEqual([])
      snapshot.cardsByPaneKey.get(source.paneKey!)!.stateChangedAt = 0
      expect(sessionsOutsideFleet([source], [receipt], snapshot)).toEqual([source])
    }
  })

  it('preserves a pending source and shows a standalone receipt only when that source is not listed', () => {
    const pending = run({ admission: 'pending', verified: false, jobs: [] })
    expect(sessionsOutsideFleet([source], [pending])).toEqual([source])
    expect(project([pending], [source]).map((group) => group.key)).toEqual([
      'waiting',
      'saved-sessions'
    ])
    expect(project([pending])[0]).toMatchObject({ key: 'waiting', fleetRows: [{ run: pending }] })
  })

  it('keeps attention and completed results independently accessible in canonical group order', () => {
    const complete = run({
      workflowId: 'wf_complete',
      jobs: [{ status: 'done' } as ConsoleWorkflowJob]
    })
    const attention = run({
      workflowId: 'wf_attention',
      jobs: [{ status: 'pr_open', pr_url: 'https://example.test/pr/1' } as ConsoleWorkflowJob]
    })
    const groups = project([complete, run(), attention])
    expect(groups.map((group) => group.key)).toEqual([
      'attention',
      'workspace:other',
      'completed',
      'saved-sessions'
    ])
    expect(groups.map((group) => group.collapsed)).toEqual([false, false, true, true])
    expect(groups[0].attentionCount).toBe(1)
  })

  it('lists a run under Needs you only when its details offer a decision or a review', () => {
    const decision = run({
      workflowId: 'wf_decision',
      jobs: [{ status: 'blocked', can_decide: true } as ConsoleWorkflowJob]
    })
    const someoneElse = run({
      workflowId: 'wf_needs_human',
      jobs: [{ status: 'blocked', workflow_state: 'needs_human' } as ConsoleWorkflowJob]
    })
    const reviewElsewhere = run({
      workflowId: 'wf_awaiting_review',
      jobs: [{ status: 'awaiting_review' } as ConsoleWorkflowJob]
    })
    const groups = project([decision, someoneElse, reviewElsewhere])
    expect(groups.map((group) => group.key)).toEqual(['attention', 'waiting', 'saved-sessions'])
    expect(groups[0].fleetRows.map((row) => row.run.workflowId)).toEqual(['wf_decision'])
    expect(groups[0].attentionCount).toBe(1)
    expect(groups[1].fleetRows.map((row) => row.run.workflowId)).toEqual([
      'wf_needs_human',
      'wf_awaiting_review'
    ])
  })

  it('never lists a failed run under Needs you, and never counts it', () => {
    const failed = run({
      workflowId: 'wf_failed',
      jobs: [{ status: 'failed' } as ConsoleWorkflowJob, { status: 'done' } as ConsoleWorkflowJob]
    })
    const rejected = run({
      workflowId: 'wf_rejected',
      jobs: [{ status: 'rejected' } as ConsoleWorkflowJob]
    })
    const groups = project([failed, rejected])
    expect(groups.map((group) => group.key)).toEqual(['stopped', 'saved-sessions'])
    expect(groups[0].fleetRows.map((row) => row.run.workflowId)).toEqual([
      'wf_failed',
      'wf_rejected'
    ])
    expect(groups.every((group) => group.attentionCount === 0)).toBe(true)
  })

  it('merges timed waiting and fleet work into one persisted, searchable Waiting group', () => {
    const view = setSessionGroupsCollapsed(emptySessionSidebarView(), ['waiting'], false)
    const tree = buildSessionSidebarTree({
      sessions: [source],
      metadata: emptySessionFolderMetadata(),
      view,
      snapshot: EMPTY_AGENT_PANE_SNAPSHOT,
      query: '',
      showHidden: false,
      waitingUntilByPaneKey: new Map([[source.paneKey!, '2026-09-13T14:00:00.000Z']])
    })
    const groups = addConversationFleetGroups({
      groups: tree.groups,
      sessions: [source],
      runs: [
        run({
          rowKey: 'other',
          sessionKey: null,
          jobs: [{ status: 'queued' } as ConsoleWorkflowJob]
        })
      ],
      view,
      query: ''
    })
    expect(groups.map((group) => group.key)).toEqual(['waiting', 'saved-sessions'])
    expect(groups[0]).toMatchObject({ key: 'waiting', label: 'Waiting', collapsed: false })
    expect(groups[0].rows).toHaveLength(1)
    expect(groups[0].fleetRows).toHaveLength(1)
    expect(project([run()], [], 'mw0002')[0].collapsed).toBe(false)
    expect(project([run()], [], 'missing')).toEqual([])
  })
})

describe('fleet source organization', () => {
  it('hides or archives the receipt together with its selected source session', () => {
    const input = { groups: [], sessions: [source], runs: [run()], query: '' }
    const hiddenView = { ...emptySessionSidebarView(), hidden: ['conversation:source-session'] }
    // Why: an open source is always listed, so its receipt stays too; it hides once the tab closes.
    expect(addConversationFleetGroups({ ...input, view: hiddenView })[0]?.kind).not.toBe('hidden')
    const hidden = addConversationFleetGroups({
      ...input,
      sessions: [closedSource],
      view: hiddenView
    })
    expect(hidden[0]?.kind).toBe('hidden')
    const view = { ...emptySessionSidebarView(), archived: ['source-session'] }
    expect(addConversationFleetGroups({ ...input, view })).toHaveLength(0)
    expect(addConversationFleetGroups({ ...input, view, showArchived: true })[0]?.kind).toBe(
      'archived'
    )
  })

  it('returns a snoozed fleet receipt when its deadline passes', () => {
    const input = {
      groups: [],
      sessions: [source],
      runs: [run()],
      query: '',
      view: { ...emptySessionSidebarView(), snoozedUntil: { 'source-session': 2000 } }
    }
    expect(addConversationFleetGroups({ ...input, now: 1999 })[0]?.kind).toBe('waiting')
    expect(addConversationFleetGroups({ ...input, now: 2000 })[0]?.kind).toBe('workspace')
  })
})

describe('fleet row view keys', () => {
  it('reads one key for a run whether or not its source is still listed', () => {
    expect(conversationFleetRowKey(run(), source)).toBe('source-session')
    expect(conversationFleetRowKey(run(), null)).toBe('source-session')
    expect(conversationFleetRowKey(run({ sessionKey: null }), null)).toBe('source-row')
    // Why: a source that learned its provider session after dispatch keeps the row under that key.
    expect(conversationFleetRowKey(run({ sessionKey: null }), source)).toBe('source-session')
    expect(conversationFleetSource(run(), [source])).toBe(source)
    expect(conversationFleetSource(run({ sessionKey: 'other' }), [source])).toBeNull()
  })

  it('reads either legacy hidden mark and files a hand-archived orphan under Archived', () => {
    const hidden = { ...emptySessionSidebarView(), hidden: ['session:source-session'] }
    expect(isConversationFleetRowHidden(hidden, run(), null)).toBe(true)
    // The mark reads the same open or closed; only grouping waits for the tab to close.
    expect(isConversationFleetRowHidden(hidden, run(), closedSource)).toBe(true)
    expect(isConversationFleetRowHidden(hidden, run(), source)).toBe(true)
    expect(isConversationFleetRowHidden(emptySessionSidebarView(), run(), source)).toBe(false)
    const view = { ...emptySessionSidebarView(), archived: ['source-row'] }
    const orphan = run({ sessionKey: null })
    expect(
      addConversationFleetGroups({ groups: [], sessions: [], runs: [orphan], view, query: '' })
    ).toEqual([])
    expect(
      addConversationFleetGroups({
        groups: [],
        sessions: [],
        runs: [orphan],
        view,
        query: '',
        showArchived: true
      }).map((group) => [group.kind, group.fleetRows.length])
    ).toEqual([['archived', 1]])
  })
})
