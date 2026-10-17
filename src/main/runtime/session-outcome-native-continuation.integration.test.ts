import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import { bindNativeOutcomeSource } from './session-outcome-native-test-fixture'
import { installSessionOutcomeTaskContinuation } from './session-outcome-task-continuation'
import { sessionOutcomeProgress } from '../../shared/session-outcome-state'
import { observeSessionOutcomeAttempt } from './session-outcome-executor'
import type { SessionOutcomeDefinition } from '../../shared/session-outcome-types'

const fixtures: ReturnType<typeof outcomeRuntimeFixture>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.dispose()
  }
})
const base = (workspace: string) => ({
  id: 'chain',
  workspacePath: workspace,
  worktreeId: 'folder:outcome',
  hostId: 'local',
  sourcePaneKey: 'source',
  sourceRowKey: 'row',
  auto: true,
  steps: [],
  currentIndex: 0,
  state: 'waiting',
  createdAt: 1,
  updatedAt: 1
})
const definition = (id: string, dir: string): SessionOutcomeDefinition => ({
  id,
  title: id,
  finish: 'complete',
  dependsOn: [],
  conditions: [{ id: 'file', kind: 'file', target: join(dir, `${id}.txt`) }],
  actions: [
    {
      id,
      instruction: `ACTION:${id}`,
      agent: 'codex',
      model: id === 'one' ? 'gpt-5.6-sol' : 'gpt-6-astra',
      effort: 'high',
      conditionIds: ['file'],
      authority: 'existing-user-authority'
    }
  ]
})
async function setup(failFirst = false, settledSource = false) {
  const f = outcomeRuntimeFixture((brief, workspace) => {
    const id = /ACTION:(\w+)/.exec(brief)![1]!
    if (failFirst && id === 'one') {
      return { body: 'Missing access for one', outcome: 'failed' }
    }
    writeFileSync(join(workspace, `${id}.txt`), 'actual output')
    return { body: `Produced ${id}` }
  })
  fixtures.push(f)
  const native = await bindNativeOutcomeSource(f)
  if (settledSource) {
    await native.settleSource()
  }
  const bff = vi.fn()
  installSessionOutcomeTaskContinuation(bff)
  await f.service.commit(base(f.workspace), {
    expectedRevision: 0,
    source: 'user',
    outcomes: [definition('one', f.workspace), definition('two', f.workspace)]
  })
  f.service.dispose()
  return { f, native, bff }
}
async function finish(f: ReturnType<typeof outcomeRuntimeFixture>) {
  for (let i = 0; i < 8; i++) {
    await f.service.tick()
    await f.settle()
  }
}

it('saves without effects, then runs independent outcomes on the same card projection with exact models', async () => {
  const { f, native, bff } = await setup()
  await f.service.tick()
  expect(f.launched).toEqual([])
  expect(f.service.get('chain').outcomeSet!.continuation).toMatchObject({
    taskId: 'btk_nativeoutcomes',
    nativeSource: {
      runId: native.run.id,
      projectionTaskId: native.projectionTaskId,
      sourceDispatchId: native.source.id
    }
  })
  await native.settleSource()
  await finish(f)
  const saved = f.service.get('chain')
  expect(sessionOutcomeProgress(saved.outcomeSet!).lifecycle).toBe('complete')
  const attempts = saved.outcomeSet!.attempts
  expect(attempts).toHaveLength(2)
  expect(new Set(attempts.map((attempt) => attempt.taskId))).toEqual(
    new Set([native.projectionTaskId])
  )
  expect(new Set(attempts.map((attempt) => attempt.runId))).toEqual(new Set([native.run.id]))
  expect(attempts.map((attempt) => attempt.nativeContinuation!.previousDispatchId)).toEqual([
    native.source.id,
    attempts[0]!.dispatchId
  ])
  expect(
    attempts.map(
      (attempt) =>
        JSON.parse(f.db.getWorkerDispatch(attempt.dispatchId!)!.start_options).launch.requested
          .model
    )
  ).toEqual(['gpt-5.6-sol', 'gpt-6-astra'])
  expect(f.db.listTasks({ runId: native.run.id })).toHaveLength(1)
  expect(f.db.getTask(native.projectionTaskId)).toMatchObject({
    hub_task_id: 'btk_nativeoutcomes',
    spec: 'btk_nativeoutcomes',
    hub_state_revision: null
  })
  expect(() => f.db.createTask({ runId: native.run.id, spec: 'duplicate business task' })).toThrow(
    /read.only|hub|omnios/i
  )
  expect(
    f.launched.every((brief) => brief.includes('Do not complete or reassign the hub task'))
  ).toBe(true)
  expect(
    f.launched.every((brief) => brief.includes('ACTION:one') && brief.includes('ACTION:two'))
  ).toBe(true)
  await f.service.tick()
  expect(f.launched).toHaveLength(2)
  expect(bff).not.toHaveBeenCalled()
})

it('recovers the persisted operation after a lost dispatch response and database reopen without relaunching', async () => {
  const { f, native, bff } = await setup()
  await native.settleSource()
  await f.service.tick()
  await f.settleReports()
  const saved = f.service.get('chain')
  const attempt = saved.outcomeSet!.attempts[0]!
  expect(attempt.dispatchId).toBeTruthy()
  const lost = {
    ...attempt,
    dispatchId: undefined,
    state: 'unverifiable' as const,
    error: 'response lost'
  }
  f.service.save(
    { ...saved, outcomeSet: { ...saved.outcomeSet!, attempts: [lost] } },
    saved.outcomeSet!.revision
  )
  await f.service.suspend()
  f.closeDatabase()
  const reopened = outcomeRuntimeFixture((_brief, workspace) => {
    writeFileSync(join(workspace, 'two.txt'), 'remaining authorized stage')
    return { body: 'Remaining authorized stage' }
  }, f.workspace)
  fixtures.push(reopened)
  const recovered = observeSessionOutcomeAttempt(reopened.runtime, lost)
  expect(recovered).toMatchObject({
    dispatchId: attempt.dispatchId,
    state: 'completed',
    error: undefined
  })
  expect(reopened.db.listTasks({ runId: native.run.id })).toHaveLength(1)
  expect(bff).not.toHaveBeenCalled()
  expect(reopened.launched).toEqual([])
  await finish(reopened)
  const resumed = reopened.service.get('chain')
  expect(sessionOutcomeProgress(resumed.outcomeSet!).lifecycle).toBe('complete')
  expect(resumed.outcomeSet!.attempts).toHaveLength(2)
  expect(resumed.outcomeSet!.attempts[0]!.dispatchId).toBe(attempt.dispatchId)
  expect(f.launched).toHaveLength(1)
  expect(reopened.launched).toHaveLength(1)
})

it('does not mistake an unrelated latest dispatch for its missing operation receipt', async () => {
  const { f, native } = await setup()
  await native.settleSource()
  await f.service.tick()
  await f.settleReports()
  const saved = f.service.get('chain')
  const attempt = saved.outcomeSet!.attempts[0]!
  const alien = f.db.createStartingWorkerDispatch({
    taskId: native.projectionTaskId,
    continueFrom: f.db.getDispatchContext(native.projectionTaskId)!.id,
    creator: { kind: 'system' },
    maxDepth: 3,
    startOptions: { executionBrief: 'Unrelated work' }
  }).dispatch
  expect(
    observeSessionOutcomeAttempt(f.runtime, {
      ...attempt,
      dispatchId: undefined,
      state: 'unverifiable'
    })
  ).toMatchObject({ state: 'unverifiable' })
  await f.service.tick()
  expect(f.db.getDispatchContext(native.projectionTaskId)!.id).toBe(alien.id)
  expect(f.launched.length).toBeLessThanOrEqual(2)
})

it('refuses a changed source origin without converting a Console execution into a native worker', async () => {
  const { f, native, bff } = await setup()
  await native.settleSource()
  f.db.db.prepare("UPDATE runs SET origin = 'hub_dispatched' WHERE id = ?").run(native.run.id)
  await f.service.tick()
  expect(f.launched).toEqual([])
  expect(bff).not.toHaveBeenCalled()
  expect(f.service.get('chain').outcomeSet!.attempts[0]).toMatchObject({
    state: 'blocked',
    error: 'The stored source is not this card’s native dispatcher Run.'
  })
})

it('retains runtime-derived source identity when an edit supplies different Run and Task IDs', async () => {
  const { f, native } = await setup()
  const saved = f.service.get('chain')
  const forged = structuredClone(saved)
  forged.outcomeSet!.continuation.nativeSource = {
    runId: 'run_forged',
    projectionTaskId: 'task_forged',
    sourceDispatchId: 'ctx_forged'
  }
  const edited = await f.service.commit(forged, {
    expectedRevision: saved.outcomeSet!.revision,
    source: 'user',
    outcomes: [definition('one', f.workspace), definition('two', f.workspace)]
  })
  expect(edited.outcomeSet!.continuation.nativeSource).toEqual({
    runId: native.run.id,
    projectionTaskId: native.projectionTaskId,
    sourceDispatchId: native.source.id
  })
  expect(f.launched).toEqual([])
})

it('will not use a different model or predecessor receipt to recover the operation', async () => {
  const { f, native } = await setup()
  await native.settleSource()
  await f.service.tick()
  await f.settleReports()
  const attempt = f.service.get('chain').outcomeSet!.attempts[0]!
  const worker = f.db.getWorkerDispatch(attempt.dispatchId!)!
  const observed = { ...attempt, state: 'unverifiable' as const }
  const options = JSON.parse(worker.start_options)
  for (const changed of [
    { ...options, continueFrom: 'ctx_unrelated' },
    { ...options, executionBrief: 'Unrelated operation' },
    {
      ...options,
      launch: {
        ...options.launch,
        requested: { ...options.launch.requested, model: 'different-model' }
      }
    }
  ]) {
    f.db.db
      .prepare('UPDATE worker_dispatches SET start_options = ? WHERE dispatch_id = ?')
      .run(JSON.stringify(changed), attempt.dispatchId!)
    expect(observeSessionOutcomeAttempt(f.runtime, observed).state).toBe('unverifiable')
  }
  f.db.db
    .prepare('UPDATE worker_dispatches SET start_options = ? WHERE dispatch_id = ?')
    .run(worker.start_options, attempt.dispatchId!)
  expect(observeSessionOutcomeAttempt(f.runtime, observed).state).toBe('completed')
})

it('retains a settled source’s card identity when Save follows its worker report', async () => {
  const { f, native } = await setup(false, true)
  expect(f.service.get('chain').outcomeSet!.continuation.nativeSource?.sourceDispatchId).toBe(
    native.source.id
  )
  await finish(f)
  expect(f.launched).toHaveLength(2)
  expect(f.db.listTasks({ runId: native.run.id })).toHaveLength(1)
})

it('continues an independent outcome after a sibling worker failure on the same projection', async () => {
  const { f, native } = await setup(true)
  await native.settleSource()
  await finish(f)
  const saved = f.service.get('chain')
  // The failed sibling is the host's to recover within bounds (its backoff is still running
  // here); a dead worker is never a request for the person, and it never holds its sibling back.
  expect(sessionOutcomeProgress(saved.outcomeSet!)).toMatchObject({
    phase: 'recovering',
    lifecycle: 'waiting',
    attention: [],
    satisfied: 1,
    total: 2
  })
  expect(saved.outcomeSet!.attempts[0]).toMatchObject({
    state: 'blocked',
    failure: { code: 'agent-turn-failed' }
  })
  expect(f.launched).toHaveLength(2)
  expect(saved.outcomeSet!.attempts[1]!.nativeContinuation!.previousDispatchId).toBe(
    saved.outcomeSet!.attempts[0]!.dispatchId
  )
  expect(f.db.listTasks({ runId: native.run.id })).toHaveLength(1)
})

it('recovers a pre-dispatch native launch exception as not-started using the unchanged settled predecessor', async () => {
  const { f, native } = await setup(false, true)
  const attempt = {
    id: 'launch_absence',
    outcomeId: 'one',
    actionId: 'one',
    actionKey: 'unused-before-dispatch',
    outcomeRevision: 1,
    state: 'unverifiable',
    startedAt: 1,
    updatedAt: 1,
    taskId: native.projectionTaskId,
    runId: native.run.id,
    continuationTaskId: 'btk_nativeoutcomes',
    nativeContinuation: {
      previousDispatchId: native.source.id,
      worktreeId: 'folder:outcome',
      briefSha256: 'a'.repeat(64)
    }
  } as const
  expect(observeSessionOutcomeAttempt(f.runtime, attempt)).toMatchObject({
    state: 'blocked',
    launchDisposition: 'not-started'
  })
  f.db.createStartingWorkerDispatch({
    taskId: native.projectionTaskId,
    creator: { kind: 'system' },
    maxDepth: 3,
    continueFrom: native.source.id,
    startOptions: { executionBrief: 'Another actual launch' }
  })
  expect(observeSessionOutcomeAttempt(f.runtime, attempt).state).toBe('unverifiable')
})
