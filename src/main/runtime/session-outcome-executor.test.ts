import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './orchestration/db'
import type { OrcaRuntimeService } from './omni-runtime'
import type { SessionOutcomeAttempt } from '../../shared/session-outcome-types'
import {
  observeSessionOutcomeAttempt,
  sessionOutcomeExecutionBrief
} from './session-outcome-executor'
import { resumeSessionOutcomeWork } from './session-outcome-resume'
import type { SessionOutcomeService } from './session-outcome-service'
import { normalizeSessionChain, type SessionChain } from '../../shared/session-chain-types'
import { reviseSessionOutcomeSet } from '../../shared/session-outcome-state'

const dirs: string[] = [],
  databases: OrchestrationDb[] = []
afterEach(() => {
  databases.splice(0).forEach((db) => db.close())
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'outcome-dispatch-'))
  dirs.push(dir)
  const path = join(dir, 'orchestration.db')
  const db = new OrchestrationDb(path)
  databases.push(db)
  const run = db.createRun({
    objective: 'Outcome action',
    coordinatorHandle: 'term_owner',
    coordinatorPaneKey: 'tab_owner:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  })
  const task = db.createTask({ runId: run.id, spec: 'Create the requested output' })
  const { dispatch } = db.createStartingWorkerDispatch({
    taskId: task.id,
    creator: { kind: 'system' },
    maxDepth: 3,
    startOptions: { agent: 'codex' }
  })
  const runtime = {
    getOrchestrationDb: () => db,
    getFreshAgentHookStatusForHandle: () => null
  } as unknown as OrcaRuntimeService
  const attempt: SessionOutcomeAttempt = {
    id: 'attempt',
    actionId: 'publish',
    actionKey: 'publish-once',
    outcomeId: 'release',
    outcomeRevision: 1,
    state: 'launching',
    taskId: task.id,
    runId: run.id,
    startedAt: 1,
    updatedAt: 1
  }
  return { db, runtime, dispatch, task, attempt, path }
}

describe('real orchestration dispatch recovery for outcomes', () => {
  it('finds a persisted dispatch after a response was lost and never assumes exit', () => {
    const f = fixture()
    const result = observeSessionOutcomeAttempt(f.runtime, f.attempt)
    expect(result).toMatchObject({ dispatchId: f.dispatch.id, state: 'unverifiable' })
    expect(f.db.getDispatchContext(f.task.id)?.id).toBe(f.dispatch.id)
    expect(observeSessionOutcomeAttempt(f.runtime, result).dispatchId).toBe(f.dispatch.id)
  })
  it('rehydrates the same launch after reopening the on-disk database', () => {
    const f = fixture()
    f.db.close()
    databases.splice(databases.indexOf(f.db), 1)
    const reopened = new OrchestrationDb(f.path)
    databases.push(reopened)
    const runtime = {
      getOrchestrationDb: () => reopened,
      getFreshAgentHookStatusForHandle: () => null
    } as unknown as OrcaRuntimeService
    expect(observeSessionOutcomeAttempt(runtime, f.attempt)).toMatchObject({
      dispatchId: f.dispatch.id,
      state: 'unverifiable'
    })
    expect(reopened.getDispatchContext(f.task.id)?.id).toBe(f.dispatch.id)
  })
  it('does not turn process disappearance or absent task into completion', () => {
    const f = fixture()
    expect(observeSessionOutcomeAttempt(f.runtime, { ...f.attempt, taskId: 'missing' }).state).toBe(
      'unverifiable'
    )
    expect(
      observeSessionOutcomeAttempt(f.runtime, { ...f.attempt, dispatchId: f.dispatch.id }).state
    ).not.toBe('completed')
  })
  it('retains custom executable instructions and all obligations in each real worker brief', () => {
    const action = {
      id: 'release',
      instruction: 'Publish only the old application after its approved checks',
      conditionIds: ['receipt'],
      authority: 'existing-user-authority' as const,
      agent: 'codex' as const
    }
    const outcomes = ['old-release', 'advanced-ui'].map((id) => ({
      id,
      title: id,
      finish: 'complete' as const,
      dependsOn: [],
      actions: [action],
      conditions: [{ id: 'receipt', kind: 'file' as const, target: `/out/${id}` }]
    }))
    const set = reviseSessionOutcomeSet(
      undefined,
      { expectedRevision: 0, outcomes, source: 'user' },
      { owner: 'execution-host', hostId: 'local', epoch: 'owner', state: 'owned' },
      1
    )
    const chain = normalizeSessionChain({
      id: 'chain',
      workspacePath: '/work',
      worktreeId: 'folder:work',
      sourcePaneKey: 'pane',
      sourceRowKey: 'row',
      steps: [],
      outcomeSet: set
    })!
    const brief = sessionOutcomeExecutionBrief(chain, action, 'attempt')
    expect(brief).toContain(action.instruction)
    expect(brief).toContain('old-release')
    expect(brief).toContain('advanced-ui')
    expect(brief).toContain('company, identity, existing file IDs')
    expect(brief).toContain('Launch attempt: attempt')
  })
})

it('classifies a local coordinator launch as not started only when its owned task has no Dispatch', () => {
  const f = fixture()
  const task = f.db.createTask({ runId: f.attempt.runId!, spec: 'Undispatched action' })
  const attempt = { ...f.attempt, taskId: task.id }
  expect(observeSessionOutcomeAttempt(f.runtime, attempt)).toMatchObject({
    state: 'blocked',
    launchDisposition: 'not-started'
  })
  expect(
    observeSessionOutcomeAttempt(f.runtime, { ...attempt, dispatchId: 'ctx_missing' }).state
  ).toBe('unverifiable')
  expect(observeSessionOutcomeAttempt(f.runtime, { ...attempt, runId: 'run_unowned' }).state).toBe(
    'unverifiable'
  )
  expect(
    observeSessionOutcomeAttempt(f.runtime, { ...attempt, continuationTaskId: 'btk_external' })
      .state
  ).toBe('unverifiable')
})

it('recovers a saved local Run with no Task as not started, but leaves an unknown Task unverifiable', () => {
  const f = fixture()
  const run = f.db.createRun({
    objective: 'Interrupted outcome action',
    coordinatorHandle: 'term_interrupted',
    coordinatorPaneKey: 'tab_interrupted:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  })
  const interrupted = {
    ...f.attempt,
    runId: run.id,
    taskId: undefined,
    dispatchId: undefined,
    coordinatorHandle: 'term_interrupted',
    coordinatorPaneKey: run.coordinator_pane_key!,
    state: 'launching' as const
  }
  expect(observeSessionOutcomeAttempt(f.runtime, interrupted, 7_000)).toMatchObject({
    state: 'blocked',
    launchDisposition: 'not-started',
    failure: { code: 'launch-not-started', at: 7_000 }
  })
  expect(
    observeSessionOutcomeAttempt(f.runtime, {
      ...interrupted,
      coordinatorPaneKey: 'tab_other:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    }).state
  ).toBe('unverifiable')

  const cardBound = f.db.createRun({
    objective: 'Card-bound interrupted action',
    coordinatorHandle: 'term_card_bound',
    coordinatorPaneKey: 'tab_card_bound:dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    hubTaskId: 'btk_cardbound'
  })
  expect(
    observeSessionOutcomeAttempt(f.runtime, {
      ...interrupted,
      runId: cardBound.id,
      coordinatorHandle: 'term_card_bound',
      coordinatorPaneKey: cardBound.coordinator_pane_key!
    }).state
  ).toBe('unverifiable')

  f.db.createTask({ runId: run.id, spec: 'Task response may have been lost' })
  expect(observeSessionOutcomeAttempt(f.runtime, interrupted).state).toBe('unverifiable')
})

it('reconciles the saved Run-only checkpoint before Resume spends a replacement', async () => {
  const f = fixture()
  const run = f.db.createRun({
    objective: 'Interrupted outcome action',
    coordinatorHandle: 'term_interrupted',
    coordinatorPaneKey: 'tab_interrupted:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  })
  const interrupted = {
    ...f.attempt,
    runId: run.id,
    taskId: undefined,
    dispatchId: undefined,
    coordinatorHandle: 'term_interrupted',
    coordinatorPaneKey: run.coordinator_pane_key!,
    state: 'launching' as const
  }
  const chain = {
    id: 'chain',
    workspacePath: '/work',
    worktreeId: 'folder:work',
    sourcePaneKey: 'pane',
    sourceRowKey: 'row',
    auto: true,
    steps: [],
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1,
    outcomeSet: {
      revision: 1,
      outcomes: [
        {
          id: 'release',
          title: 'Release',
          revision: 1,
          status: 'pending',
          dependsOn: [],
          conditions: [{ id: 'receipt', kind: 'file', target: '/not-produced/release.txt' }],
          actions: [
            {
              id: 'publish',
              instruction: 'Publish',
              conditionIds: ['receipt'],
              authority: 'existing-user-authority',
              agent: 'codex'
            }
          ],
          evidence: []
        }
      ],
      attempts: [interrupted],
      continuation: { owner: 'execution-host', hostId: 'local', epoch: 'owner', state: 'owned' }
    }
  } as unknown as SessionChain
  const service = {
    runtime: f.runtime,
    launches: { inFlight: () => false },
    save: (next: SessionChain) => next
  } as unknown as SessionOutcomeService

  const resumed = await resumeSessionOutcomeWork(service, chain, 7_000)
  expect(resumed.outcomeSet!.attempts[0]).toMatchObject({ state: 'retryable' })
})

it('keeps an uncertain launch without task identity unverifiable after the prepared checkpoint', () => {
  const f = fixture()
  const { taskId: _taskId, runId: _runId, ...attempt } = f.attempt
  expect(observeSessionOutcomeAttempt(f.runtime, { ...attempt, state: 'prepared' })).toMatchObject({
    state: 'blocked',
    launchDisposition: 'not-started'
  })
  for (const state of ['launching', 'unverifiable'] as const) {
    const result = observeSessionOutcomeAttempt(f.runtime, { ...attempt, state })
    expect(result.state).toBe('unverifiable')
    expect(result.launchDisposition).not.toBe('not-started')
  }
  expect(
    observeSessionOutcomeAttempt(f.runtime, {
      ...attempt,
      state: 'prepared',
      dispatchId: 'ctx_missing'
    }).state
  ).toBe('unverifiable')
})

describe('why an attempt stopped, and when', () => {
  const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

  it('records a failure code from the dispatch stage and the moment it was seen', () => {
    const f = fixture()
    f.db.failWorkerStart(
      f.dispatch.id,
      'agent_readiness',
      'Agent startup blocked: codex-hooks-review-prompt'
    )
    const result = observeSessionOutcomeAttempt(f.runtime, f.attempt, 9_000)
    expect(result).toMatchObject({
      state: 'blocked',
      launchDisposition: 'started',
      dispatchId: f.dispatch.id,
      error: 'Agent startup blocked: codex-hooks-review-prompt',
      failure: { code: 'startup-blocked', detail: 'codex-hooks-review-prompt', at: 9_000 },
      // The recovery ladder measures its backoff from here; launch latency is not a failure time.
      updatedAt: 9_000
    })
    // A stopped attempt is settled: re-observing it changes nothing, so the clock never restarts.
    expect(observeSessionOutcomeAttempt(f.runtime, result, 99_000)).toBe(result)
  })

  it('stamps a launch that never started, so the ladder may retry it', () => {
    const f = fixture()
    const task = f.db.createTask({ runId: f.attempt.runId!, spec: 'Undispatched action' })
    expect(
      observeSessionOutcomeAttempt(f.runtime, { ...f.attempt, taskId: task.id }, 7_000)
    ).toMatchObject({
      state: 'blocked',
      launchDisposition: 'not-started',
      failure: { code: 'launch-not-started', at: 7_000 },
      updatedAt: 7_000
    })
  })

  it('keeps the moment contact was lost when the same silence is read again', () => {
    const f = fixture()
    const lost = observeSessionOutcomeAttempt(f.runtime, f.attempt, 3_000)
    expect(lost).toMatchObject({ state: 'unverifiable', updatedAt: 3_000 })
    expect(lost.failure).toBeUndefined()
    // The grace period of an unverifiable worker runs from the first loss, not from every tick.
    expect(observeSessionOutcomeAttempt(f.runtime, lost, 60_000)).toEqual(lost)
  })

  it('reads an agent asking its person something as alive, with its prompt on awaiting', () => {
    const f = fixture()
    f.db.prepareStartingWorkerAuthority({
      dispatchId: f.dispatch.id,
      handle: 'term_worker',
      paneKey: PANE_KEY,
      processIncarnation: 'runtime:pty:1',
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: [{ kind: 'terminal', action: 'created', id: 'term_worker' }]
    })
    f.db.markWorkerDispatchReady(f.dispatch.id)
    let hook: Record<string, unknown> = {
      state: 'waiting',
      interactivePrompt: JSON.stringify({
        questions: [{ question: 'Which database should I use?' }]
      }),
      lastAssistantMessage: null,
      stateStartedAt: 4_000,
      updatedAt: 8_000
    }
    const runtime = {
      getOrchestrationDb: () => f.db,
      getFreshAgentHookStatusForHandle: () => hook
    } as unknown as OrcaRuntimeService

    const asking = observeSessionOutcomeAttempt(runtime, f.attempt, 9_000)
    expect(asking).toMatchObject({
      state: 'running',
      awaiting: {
        kind: 'clarification',
        prompt: 'Which database should I use?',
        since: 4_000,
        paneKey: PANE_KEY
      }
    })
    // A question is not a failure: nothing may read this attempt as stopped.
    expect(asking.error).toBeUndefined()
    expect(asking.failure).toBeUndefined()
    expect(observeSessionOutcomeAttempt(runtime, asking, 12_000)).toEqual(asking)

    hook = {
      ...hook,
      state: 'blocked',
      interactivePrompt: JSON.stringify({ approval: { tool: 'Bash', summary: 'rm -rf build' } })
    }
    expect(observeSessionOutcomeAttempt(runtime, asking, 13_000).awaiting).toMatchObject({
      kind: 'permission',
      prompt: 'Bash rm -rf build'
    })

    hook = { ...hook, state: 'working', interactivePrompt: null }
    const answered = observeSessionOutcomeAttempt(runtime, asking, 14_000)
    expect(answered.state).toBe('running')
    expect(answered.awaiting).toBeUndefined()
  })
})
