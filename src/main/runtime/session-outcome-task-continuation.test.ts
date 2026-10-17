import { expect, it, vi } from 'vitest'
import { launchSessionOutcomeAction } from './session-outcome-executor'
import {
  continueSessionOutcomeTask,
  installSessionOutcomeTaskContinuation
} from './session-outcome-task-continuation'
import type { SessionChain } from '../../shared/session-chain-types'
import type {
  SessionOutcomeAction,
  SessionOutcomeAttempt
} from '../../shared/session-outcome-types'
import type { OrcaRuntimeService } from './omni-runtime'

it('reuses the task authority operation id and refuses silently dropping the selected account', async () => {
  const adapter = vi.fn().mockResolvedValue({
    ok: true,
    data: { state: 'running', dispatchId: 'dispatch', runId: 'run' }
  })
  installSessionOutcomeTaskContinuation(adapter)
  const runtime = {
    getOrchestrationDb: () => ({ getDispatchContextById: () => ({ task_id: 'local_task' }) })
  } as unknown as OrcaRuntimeService
  const chain = {
    worktreeId: 'folder:example',
    outcomeSet: { continuation: { taskId: 'business_task' } }
  } as SessionChain
  const action: SessionOutcomeAction = {
    id: 'finish',
    instruction: 'Finish',
    authority: 'existing-user-authority',
    agent: 'codex',
    model: 'model',
    effort: 'high',
    conditionIds: ['proof']
  }
  const attempt = { id: 'persisted_attempt', state: 'launching' } as SessionOutcomeAttempt
  const first = await continueSessionOutcomeTask(
    runtime,
    chain,
    action,
    attempt,
    'full execution brief'
  )
  const recovered = await continueSessionOutcomeTask(
    runtime,
    chain,
    action,
    attempt,
    'full execution brief'
  )
  expect(first).toMatchObject({
    taskId: 'local_task',
    continuationTaskId: 'business_task',
    dispatchId: 'dispatch',
    state: 'running'
  })
  expect(recovered.dispatchId).toBe(first.dispatchId)
  expect(adapter.mock.calls.map((entry) => entry[1])).toEqual(
    [1, 2].map(() => ({
      operationId: 'persisted_attempt',
      taskId: 'business_task',
      agent: 'codex',
      model: 'model',
      effort: 'high',
      instruction: 'full execution brief',
      worktree: 'id:folder:example'
    }))
  )
  await expect(
    continueSessionOutcomeTask(
      runtime,
      chain,
      { ...action, accountChoiceId: 'account' },
      attempt,
      'brief'
    )
  ).rejects.toThrow('selected account')
  expect(adapter).toHaveBeenCalledTimes(2)
})

it('records a proven unstarted attempt when the model is missing and keeps unknown sends fenced', async () => {
  const adapter = vi.fn().mockRejectedValue(new Error('transport response lost'))
  installSessionOutcomeTaskContinuation(adapter)
  const action: SessionOutcomeAction = {
    id: 'finish',
    instruction: 'Deliver the authorized report',
    authority: 'existing-user-authority',
    agent: 'codex',
    conditionIds: ['proof']
  }
  const chain = {
    worktreeId: 'folder:example',
    steps: [],
    outcomeSet: {
      continuation: { taskId: 'business_task' },
      outcomes: [{ id: 'report', revision: 1, title: 'Report' }]
    }
  } as unknown as SessionChain
  const attempts: SessionOutcomeAttempt[] = []
  const runtime = {} as OrcaRuntimeService
  const rejected = await launchSessionOutcomeAction(runtime, chain, 'report', action, (attempt) =>
    attempts.push(attempt)
  )
  expect(rejected).toMatchObject({
    state: 'blocked',
    launchDisposition: 'not-started',
    // The code the recovery ladder reads: nothing was sent, so a bounded retry duplicates nothing.
    failure: { code: 'launch-not-started' }
  })
  expect(rejected.updatedAt).toBe(rejected.failure!.at)
  expect(rejected.error).toContain('explicit provider/model')
  expect(attempts.every((attempt) => attempt.state !== 'launching')).toBe(true)
  expect(adapter).not.toHaveBeenCalled()

  const uncertain = await launchSessionOutcomeAction(
    runtime,
    chain,
    'report',
    { ...action, model: 'chosen-model' },
    () => {}
  )
  expect(uncertain).toMatchObject({ state: 'unverifiable', launchDisposition: 'unverifiable' })
  // An uncertain send carries no retryable code: the ladder holds it and never sends it again.
  expect(uncertain.failure).toBeUndefined()
  expect(adapter).toHaveBeenCalledTimes(1)
})

it('maps an adapter-proven pre-admission refusal to retryable user recovery', async () => {
  const adapter = vi.fn().mockResolvedValue({
    ok: false,
    launchDisposition: 'not-started',
    error: { code: 'capability_unavailable', message: 'Choose a supported model.' }
  })
  installSessionOutcomeTaskContinuation(adapter)
  const chain = {
    worktreeId: 'folder:example',
    steps: [],
    outcomeSet: {
      continuation: { taskId: 'business_task' },
      outcomes: [{ id: 'report', revision: 1, title: 'Report' }]
    }
  } as unknown as SessionChain
  const action: SessionOutcomeAction = {
    id: 'finish',
    instruction: 'Deliver the report',
    authority: 'existing-user-authority',
    agent: 'codex',
    model: 'chosen-model',
    conditionIds: ['proof']
  }
  const result = await launchSessionOutcomeAction(
    {} as OrcaRuntimeService,
    chain,
    'report',
    action,
    () => {}
  )
  expect(result).toMatchObject({
    state: 'blocked',
    launchDisposition: 'not-started',
    error: 'Choose a supported model.'
  })
})
