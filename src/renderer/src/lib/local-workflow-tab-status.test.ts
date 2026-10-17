import { describe, expect, it } from 'vitest'
import type {
  BuildReviewPipelineSnapshot,
  BuildReviewWorkerSnapshot
} from '../../../shared/build-review-pipeline'
import type { LocalWorkflowChangedEvent } from '../../../shared/local-workflow-rpc'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { buildSidebarSessions, type SidebarSessionSource } from './sidebar-sessions'
import { buildSessionSidebarTreeRows } from './session-sidebar-tree-rows'
import { emptySessionFolderMetadata } from './session-folders'
import { emptySessionSidebarView } from './session-sidebar-view'
import { sessionTestSource, SESSION_TEST_WORKTREE } from './sidebar-session-test-fixtures'
import { evolveChangedEvent } from '../../../shared/evolve-workflow-status'
import { evolveRunFixture } from '../components/evolve/evolve-run.fixtures'
import {
  localWorkflowAgentLine,
  localWorkflowConversationState,
  localWorkflowDotState,
  localWorkflowNeedsYou,
  localWorkflowPhaseLabel,
  localWorkflowTabStateDot,
  localWorkflowTabStatus,
  type LocalWorkflowTabStatus
} from './local-workflow-tab-status'

function workflowTab(localWorkflow: TerminalTab['localWorkflow']): TerminalTab {
  return {
    id: 'workflow-tab',
    worktreeId: SESSION_TEST_WORKTREE,
    ptyId: null,
    title: 'Which cache should we use?',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 10,
    localWorkflow
  }
}

function status(
  state: LocalWorkflowChangedEvent['state'],
  phase?: string
): LocalWorkflowChangedEvent {
  return {
    conversationId: 'workflow-tab',
    executionId: 'execution-1',
    preset: 'council',
    state,
    running: state === 'running' ? 2 : 0,
    completed: 1,
    total: 7,
    ...(phase ? { phase } : {})
  }
}

function source(
  tab: TerminalTab,
  pushed?: LocalWorkflowChangedEvent,
  stage?: BuildReviewPipelineSnapshot['stage'],
  pendingQuestion: BuildReviewPipelineSnapshot['pendingQuestion'] = null,
  pipelinesListed = false
): SidebarSessionSource {
  const state = sessionTestSource()
  state.tabsByWorktree[SESSION_TEST_WORKTREE] = [tab]
  return {
    ...state,
    localWorkflowStatusByTabId: pushed ? { [tab.id]: pushed } : {},
    buildReview: {
      pipelinesById: stage
        ? { 'pipeline-1': { stage, pendingQuestion } as BuildReviewPipelineSnapshot }
        : {},
      pipelinesListed
    } as SidebarSessionSource['buildReview']
  }
}

function sidebarRow(sessions: ReturnType<typeof buildSidebarSessions>) {
  const result = buildSessionSidebarTreeRows(
    {
      sessions,
      metadata: emptySessionFolderMetadata(),
      view: emptySessionSidebarView(),
      snapshot: {
        cardsByPaneKey: new Map(),
        cardsByTabId: new Map(),
        attentionByPaneKey: new Map()
      },
      query: '',
      showHidden: false
    },
    10
  )
  return {
    visual: result.rows[0]?.pursuitState,
    group: result.classifications.get(sessions[0]!.rowKey)
  }
}

const question: NonNullable<BuildReviewPipelineSnapshot['pendingQuestion']> = {
  messageId: 'message-1',
  role: 'builder',
  question: 'Keep the old cache key?',
  options: ['Yes', 'No'],
  askedAt: '2026-09-21T12:00:00Z'
}

const council = { preset: 'council' as const, prompt: 'Q', executionId: 'execution-1' }

describe('workflow conversations in the sidebar', () => {
  it('carries explicit benchmark provenance without guessing from the title', () => {
    const [row] = buildSidebarSessions(
      source(
        workflowTab({
          ...council,
          launch: {
            operationId: '3f9a1c2e-0000-4000-8000-000000000001',
            origin: 'benchmark',
            request: '{}'
          }
        }),
        status('completed')
      )
    )
    expect(row?.workflow).toMatchObject({ status: 'done', origin: 'benchmark' })
    const [ordinary] = buildSidebarSessions(source(workflowTab(council), status('completed')))
    expect(ordinary?.workflow?.origin).toBeUndefined()
  })
  it('keeps a never-started workflow pending and names it by its preset', () => {
    const [row] = buildSidebarSessions(source(workflowTab({ preset: 'discover', prompt: '' })))
    expect(row).toMatchObject({
      launchPending: true,
      agent: 'Discover',
      workflow: { preset: 'discover', status: 'draft' }
    })
  })

  it('shows the pushed run state and phase instead of a permanent queue', () => {
    const [row] = buildSidebarSessions(
      source(workflowTab(council), status('running', 'Peer rankings'))
    )
    expect(row.launchPending).toBeUndefined()
    expect(row).toMatchObject({
      agent: 'Council',
      workflow: { preset: 'council', status: 'running', phase: 'Peer rankings' }
    })
    expect(localWorkflowAgentLine(row.workflow!)).toBe('Council · Peer rankings')
  })

  it('captions the row with the machine the run was placed on', () => {
    const pushed = { ...status('running', 'Peer rankings'), host: 'mw0004' }
    const [row] = buildSidebarSessions(source(workflowTab(council), pushed))
    expect(row.workflow?.host).toBe('mw0004')
    expect(localWorkflowAgentLine(row.workflow!)).toBe('Council · Peer rankings · mw0004')
    const [done] = buildSidebarSessions(
      source(workflowTab(council), { ...pushed, state: 'completed' })
    )
    expect(localWorkflowAgentLine(done.workflow!)).toBe('Council · mw0004')
  })

  it('shows an Evolve run from its pushed record, and a lost host as needing the person', () => {
    const run = evolveRunFixture({ conversationId: 'workflow-tab' })
    const evolve = { preset: 'evolve' as const, prompt: 'Evolve', executionId: run.id }
    const [row] = buildSidebarSessions(source(workflowTab(evolve), evolveChangedEvent(run)))
    expect(row).toMatchObject({
      agent: 'Evolve',
      workflow: {
        preset: 'evolve',
        status: 'running',
        phase: 'Evolving (3 of 8 mutations)',
        host: 'mw0001'
      }
    })
    const lost = evolveChangedEvent({ ...run, state: 'unverifiable' })
    const [unverifiable] = buildSidebarSessions(source(workflowTab(evolve), lost))
    expect(unverifiable.workflow?.status).toBe('needs-you')
  })

  it('ignores a status that belongs to another execution of the same tab', () => {
    const stale = { ...status('completed'), executionId: 'execution-0' }
    const [row] = buildSidebarSessions(source(workflowTab(council), stale))
    expect(row.workflow?.status).toBe('unknown')
  })

  // Why (C6): a started run is never a pending launch just because its tab has no pane.
  it('shows a started run as being checked, not a draft or a pending launch, until its status arrives', () => {
    const [row] = buildSidebarSessions(source(workflowTab(council)))
    expect(row?.launchPending).toBeUndefined()
    expect(row).toMatchObject({
      agent: 'Council',
      workflow: { preset: 'council', status: 'unknown', runId: 'execution-1' }
    })
    expect(localWorkflowDotState('unknown')).toBeNull()
    expect(localWorkflowConversationState('unknown')).toBe('inactive')
  })

  it('shows an unloaded Build + Review pipeline as unknown and one never started as a draft', () => {
    const started = workflowTab({
      preset: 'build-review',
      prompt: 'Fix the cache',
      buildReviewPipelineId: 'pipeline-9'
    })
    expect(buildSidebarSessions(source(started))[0]?.workflow?.status).toBe('unknown')
    const draft = workflowTab({ preset: 'build-review', prompt: '' })
    expect(buildSidebarSessions(source(draft))[0]?.workflow?.status).toBe('draft')
  })

  it('shows a run the host no longer lists as run not found after a restart, not as waiting', () => {
    const restored = workflowTab({
      preset: 'build-review',
      prompt: 'Fix the cache',
      buildReviewPipelineId: 'pipeline-9'
    })
    const [row] = buildSidebarSessions(source(restored, undefined, undefined, null, true))
    expect(row?.workflow?.status).toBe('missing')
    expect(row?.launchPending).toBeUndefined()
    expect(localWorkflowAgentLine(row!.workflow!)).toBe('Build + Review · run not found')
    expect(localWorkflowTabStatus(restored.localWorkflow!, undefined, {}, true)).toBe('missing')
    // A run the host does list keeps its own state.
    const listed = workflowTab({
      preset: 'build-review',
      prompt: 'Fix the cache',
      buildReviewPipelineId: 'pipeline-1'
    })
    expect(
      buildSidebarSessions(source(listed, undefined, 'failed', null, true))[0]?.workflow?.status
    ).toBe('failed')
  })

  it.each([
    ['starting', 'running', 'Starting'],
    ['building', 'running', 'Building'],
    ['reviewing', 'running', 'Reviewing'],
    ['completed', 'done', undefined],
    ['failed', 'failed', undefined],
    ['cancelled', 'stopped', undefined]
  ] as const)('maps a Build + Review %s stage to %s', (stage, expected, phase) => {
    const tab = workflowTab({
      preset: 'build-review',
      prompt: 'Fix the cache',
      buildReviewPipelineId: 'pipeline-1'
    })
    const [row] = buildSidebarSessions(source(tab, undefined, stage))
    expect(row.workflow?.status).toBe(expected)
    expect(row.workflow?.phase).toBe(phase)
  })

  it('translates known phases and shows an unknown phase as the host sent it', () => {
    expect(localWorkflowPhaseLabel('Peer rankings')).toBe('Peer rankings')
    expect(localWorkflowPhaseLabel('Verify')).toBe('Verify')
    expect(localWorkflowPhaseLabel('Cross-check')).toBe('Cross-check')
    expect(
      localWorkflowAgentLine({ preset: 'discover', status: 'running', phase: 'Cross-check' })
    ).toBe('Discover · Cross-check')
    expect(localWorkflowAgentLine({ preset: 'discover', status: 'needs-you', phase: 'Find' })).toBe(
      'Discover'
    )
  })

  it('reads Build + Review state from its pipeline', () => {
    const tab = workflowTab({
      preset: 'build-review',
      prompt: 'Fix the cache',
      buildReviewPipelineId: 'pipeline-1'
    })
    const [reviewing] = buildSidebarSessions(source(tab, undefined, 'reviewing'))
    expect(reviewing.workflow).toEqual({
      preset: 'build-review',
      runId: 'pipeline-1',
      status: 'running',
      phase: 'Reviewing'
    })
    expect(localWorkflowAgentLine(reviewing.workflow!)).toBe('Build + Review · Reviewing')
    const [done] = buildSidebarSessions(source(tab, undefined, 'completed'))
    expect(done.workflow?.status).toBe('done')
    expect(localWorkflowAgentLine(done.workflow!)).toBe('Build + Review')
  })

  it('captions a Build + Review row with its placed host', () => {
    const tab = workflowTab({
      preset: 'build-review',
      prompt: 'Fix the cache',
      buildReviewPipelineId: 'pipeline-1'
    })
    const placed = source(tab, undefined, 'building')
    placed.buildReview!.pipelinesById['pipeline-1'] = {
      stage: 'building',
      pendingQuestion: null,
      placement: {
        runsOn: 'fleet',
        mode: 'local',
        host: { name: 'mw0003', machine: 'mw0003', cores: 10, loadPerCore: 0.1, readAt: 1 }
      }
    } as BuildReviewPipelineSnapshot
    const [row] = buildSidebarSessions(placed)
    expect(row.workflow?.host).toBe('mw0003')
  })

  it("files a Build + Review run waiting on a worker's question as needing the person", () => {
    const tab = workflowTab({
      preset: 'build-review',
      prompt: 'Fix the cache',
      buildReviewPipelineId: 'pipeline-1'
    })
    for (const stage of ['building', 'reviewing'] as const) {
      const sessions = buildSidebarSessions(source(tab, undefined, stage, question))
      expect(sessions[0]?.workflow).toEqual({
        preset: 'build-review',
        runId: 'pipeline-1',
        status: 'needs-you'
      })
      expect(sidebarRow(sessions)).toEqual({ visual: 'needs-you', group: 'attention' })
      expect(localWorkflowTabStateDot(sessions[0]!.workflow!.status)).toBe('needs-you')
    }
    // A question left on a run that already ended asks nothing of the person any more.
    const [failed] = buildSidebarSessions(source(tab, undefined, 'failed', question))
    expect(failed.workflow?.status).toBe('failed')
  })

  it.each([
    ['running', 'working', 'conversations'],
    // A finished workflow is Done for the person; only a sealed plan can call it verified.
    ['completed', 'done', 'completed'],
    ['failed', 'failed', 'stopped'],
    // The run header shows recovery_required as amber "Needs you"; the row agrees.
    ['recovery_required', 'needs-you', 'attention'],
    ['cancelled', 'interrupted', 'stopped'],
    ['paused', 'needs-you', 'attention'],
    ['budget_paused', 'needs-you', 'attention']
  ] as const)('files a %s run as %s under %s', (state, visual, group) => {
    const sessions = buildSidebarSessions(source(workflowTab(council), status(state)))
    expect(sidebarRow(sessions)).toEqual({ visual, group })
  })

  // Why (C6): a read that found no run, or failed, says so; neither is a pending launch.
  it.each([
    ['missing', 'missing', 'run not found'],
    ['failed', 'unavailable', 'status unavailable']
  ] as const)(
    'shows a %s read as %s (%s), kept in view and never launch-pending',
    (outcome, expected, words) => {
      const state = source(workflowTab(council))
      state.localWorkflowHydrationByTabId = {
        'workflow-tab': { runId: 'execution-1', outcome, attempts: 3 }
      }
      const sessions = buildSidebarSessions(state)
      expect(sessions[0]?.launchPending).toBeUndefined()
      expect(sessions[0]?.workflow?.status).toBe(expected)
      expect(localWorkflowAgentLine(sessions[0]!.workflow!)).toBe(`Council · ${words}`)
      expect(sidebarRow(sessions)).toEqual({ visual: 'unverifiable', group: 'waiting' })
      // An outcome for another execution of the tab says nothing about this one.
      state.localWorkflowHydrationByTabId = {
        'workflow-tab': { runId: 'execution-0', outcome, attempts: 3 }
      }
      expect(buildSidebarSessions(state)[0]?.workflow?.status).toBe('unknown')
    }
  )

  it('shows a Build + Review pipeline whose list failed as status unavailable, not stopped', () => {
    const tab = workflowTab({
      preset: 'build-review',
      prompt: 'Fix the cache',
      buildReviewPipelineId: 'pipeline-9'
    })
    const state = source(tab)
    state.localWorkflowHydrationByTabId = {
      'workflow-tab': { runId: 'pipeline-9', outcome: 'failed', attempts: 1 }
    }
    const [row] = buildSidebarSessions(state)
    expect(row?.workflow?.status).toBe('unavailable')
    expect(row?.launchPending).toBeUndefined()
  })

  it('files a draft workflow, inactive, under Drafts rather than Waiting', () => {
    const sessions = buildSidebarSessions(source(workflowTab({ preset: 'council', prompt: '' })))
    expect(sidebarRow(sessions)).toEqual({ visual: 'inactive', group: 'drafts' })
    // A started run whose state has not arrived yet still waits for it.
    const restoring = buildSidebarSessions(source(workflowTab(council)))
    expect(sidebarRow(restoring)).toEqual({ visual: 'inactive', group: 'waiting' })
  })
})

describe('workflow tab strip state', () => {
  it('treats a Start in flight as running before the first push arrives', () => {
    expect(
      localWorkflowTabStatus(
        {
          preset: 'council',
          prompt: 'Q',
          startRequest: { requestId: 'request-1', draft: {} as never }
        },
        undefined,
        undefined
      )
    ).toBe('running')
  })

  it.each([
    ['running', 'working', 'running'],
    ['needs-you', 'waiting', 'needs-you'],
    ['done', 'done', null],
    ['failed', 'failed', null],
    ['stopped', 'interrupted', null],
    ['draft', null, null],
    ['unknown', null, null],
    ['missing', null, null],
    ['unavailable', null, null]
  ] as const)('shows %s as the %s dot and %s edge dot', (tabStatus, dot, edge) => {
    expect(localWorkflowDotState(tabStatus as LocalWorkflowTabStatus)).toBe(dot)
    expect(localWorkflowTabStateDot(tabStatus as LocalWorkflowTabStatus)).toBe(edge)
  })

  it('asks for the person while a Build + Review worker waits on its startup question', () => {
    const workflow = {
      preset: 'build-review' as const,
      prompt: 'Fix',
      buildReviewPipelineId: 'pipeline-1'
    }
    const tabStatus = (pipeline: Partial<BuildReviewPipelineSnapshot>) =>
      localWorkflowTabStatus(
        workflow,
        undefined,
        { 'pipeline-1': pipeline as BuildReviewPipelineSnapshot },
        true
      )
    const waiting = {
      status: 'starting',
      startupBlocker: 'claude-folder-trust'
    } as unknown as BuildReviewWorkerSnapshot
    expect(tabStatus({ stage: 'building', builder: waiting, reviewers: [] })).toBe('needs-you')
    const started = { ...waiting, startupBlocker: undefined }
    expect(tabStatus({ stage: 'building', builder: started, reviewers: [] })).toBe('running')
    // Failed on it: the Retry path, as before.
    expect(
      tabStatus({ stage: 'failed', builder: { ...waiting, status: 'failed' }, reviewers: [] })
    ).toBe('failed')
  })

  it('files a run whose last round still asked for changes as needing the person, not failed', () => {
    const workflow = {
      preset: 'build-review' as const,
      prompt: 'Fix',
      buildReviewPipelineId: 'pipeline-1'
    }
    const verdict = (body: string) =>
      ({ status: 'succeeded', report: { body } }) as unknown as BuildReviewWorkerSnapshot
    const ended = {
      stage: 'failed' as const,
      round: 2,
      maxReviewRounds: 2,
      error: 'Review limit reached after 2 round(s); unresolved findings remain.',
      builder: verdict('done')
    }
    const tabStatus = (pipeline: Partial<BuildReviewPipelineSnapshot>) =>
      localWorkflowTabStatus(
        workflow,
        undefined,
        { 'pipeline-1': { ...ended, ...pipeline } as BuildReviewPipelineSnapshot },
        true
      )
    expect(tabStatus({ reviewers: [verdict('VERDICT: REQUEST_CHANGES')] })).toBe('needs-you')
    // A failure before the last round, or approval, is not that outcome.
    expect(tabStatus({ round: 1, reviewers: [verdict('VERDICT: REQUEST_CHANGES')] })).toBe('failed')
    expect(tabStatus({ reviewers: [verdict('VERDICT: APPROVE')] })).toBe('failed')
    // Another failure in the last round is still a failure.
    expect(
      tabStatus({
        error: 'Reviewer 2 did not provide one valid verdict; approval is not established.',
        reviewers: [verdict('VERDICT: REQUEST_CHANGES'), verdict('Looks fine.')]
      })
    ).toBe('failed')
  })

  it('asks for the person only when a run waits on them', () => {
    expect(localWorkflowNeedsYou({ preset: 'council', status: 'needs-you' })).toBe(true)
    expect(localWorkflowNeedsYou({ preset: 'council', status: 'running' })).toBe(false)
    expect(localWorkflowNeedsYou(undefined)).toBe(false)
  })
})
