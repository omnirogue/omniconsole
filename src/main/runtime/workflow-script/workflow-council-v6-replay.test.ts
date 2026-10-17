import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import { WorkflowScriptSlots } from './workflow-script-slots'
import { hasWorkflowRetryableCalls } from './workflow-retry-eligibility'
import {
  WorkflowExecutionService,
  type WorkflowProgramSnapshot
} from './workflow-execution-service'
import type { WorkflowAttemptLaunch } from './workflow-durable-call'
import type { CouncilV6Result } from './presets/council-v6'

const databases: OrchestrationDb[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

const snapshot: WorkflowProgramSnapshot = {
  version: 1,
  councilProgramRevision: 6,
  task: { prompt: 'Should the cache be per tenant?', evidence: '' },
  synthesizerId: 'claude',
  seats: [
    ['claude', 'claude', 'claude-model', 'anthropic'],
    ['codex', 'codex', 'gpt-model', 'openai'],
    ['codex-b', 'codex', 'gpt-model', 'openai']
  ].map(([id, agent, model, lineage]) => ({
    id,
    agent,
    accountId: `${id}-account`,
    model,
    effort: 'low',
    lineage,
    policyRevision: 'fixture-v1'
  })) as WorkflowProgramSnapshot['seats'],
  council: { memberIds: ['claude', 'codex', 'codex-b'] }
}

type Launch = Parameters<WorkflowAttemptLaunch>[0]
/** timeout: killed by the call's own timeout; exit: a non-zero exit; unranked: no label parsed. */
type Failure = 'timeout' | 'exit' | 'unranked'

function text(input: Launch): string {
  if (input.call.id.startsWith('answer/')) {
    return `Answer from ${input.call.seatId}`
  }
  return input.call.id.startsWith('rank/')
    ? 'Both are sound.\n\nFINAL RANKING:\n1. Response A\n2. Response B'
    : 'Per tenant, with a shared warm tier.'
}

function native(input: Launch, answer = text(input)) {
  const { attemptId } = input
  const agent = snapshot.seats.find((seat) => seat.id === input.call.seatId)!.agent
  const stdout =
    agent === 'codex'
      ? [
          { type: 'thread.started', thread_id: attemptId },
          { type: 'item.completed', item: { type: 'agent_message', text: answer } },
          { type: 'turn.completed', usage: {} }
        ]
          .map((event) => JSON.stringify(event))
          .join('\n')
      : JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: attemptId,
          result: answer,
          modelUsage: { 'claude-model': {} },
          usage: {}
        })
  return {
    result: { code: 0, signal: null, timedOut: false, stdout, stderr: '' },
    receipt: { attemptId, processReceiptRef: attemptId, liveness: 'exited' as const }
  }
}

function failure(input: Launch, kind: Failure) {
  if (kind === 'unranked') {
    return native(input, 'I would rather not rank these.')
  }
  const exited = native(input)
  return {
    ...exited,
    result:
      kind === 'timeout'
        ? { code: null, signal: 'SIGTERM' as const, timedOut: true, stdout: '', stderr: '' }
        : { code: 1, signal: null, timedOut: false, stdout: '', stderr: 'crashed' }
  }
}

/** Each listed call fails its first `times` launches, then answers normally. */
function councilRun(
  failing: Record<string, [Failure, number]>,
  onLaunch?: (input: Launch, service: WorkflowExecutionService, id: string) => void
) {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const store = new WorkflowCheckpointStore(db.db)
  const launched: string[] = []
  let id = ''
  const service: WorkflowExecutionService = new WorkflowExecutionService({
    store,
    slots: new WorkflowScriptSlots(1),
    reservation: 1,
    // As the host runs it: two attempts per run, a third left for Retry.
    attemptsPerRun: 2,
    launch: () => async (input) => {
      launched.push(input.call.id)
      input.recordLaunch(input.attemptId)
      onLaunch?.(input, service, id)
      const plan = failing[input.call.id]
      const launches = launched.filter((callId) => callId === input.call.id).length
      return plan && launches <= plan[1] ? failure(input, plan[0]) : native(input)
    },
    progress: vi.fn()
  })
  id = service.start({
    conversationId: 'council',
    requestId: 'one',
    snapshot: structuredClone(snapshot),
    preset: 'council',
    fence: 1,
    attemptLimit: 3,
    callLimit: 7,
    budgetLimit: 21
  })
  const count = (callId: string) => launched.filter((entry) => entry === callId).length
  const retryable = () => hasWorkflowRetryableCalls(db.db, id, 3)
  const errors = (callId: string) =>
    (
      db.db
        .prepare(
          'SELECT receipt_json FROM local_workflow_attempts WHERE call_id=? ORDER BY ordinal'
        )
        .all(callId) as { receipt_json: string }[]
    ).map((row) => JSON.parse(row.receipt_json).error as string | undefined)
  return { db, store, service, id, launched, count, retryable, errors }
}

describe('Council revision 6 degrades instead of dying', () => {
  it('completes around a member that timed out on every attempt and replays it as a null', async () => {
    const run = councilRun({ 'answer/codex-b': ['timeout', 3] })
    const outcome = await run.service.wait(run.id)
    expect(outcome.state).toBe('completed')
    const result = outcome.result as CouncilV6Result
    expect(result.answers.map((answer) => answer.seatId)).toEqual(['claude', 'codex'])
    expect(result.ballots).toHaveLength(3)
    expect(result.final).toEqual({
      seatId: 'claude',
      markdown: 'Per tenant, with a shared warm tier.'
    })
    expect(run.count('answer/codex-b')).toBe(2)
    expect(run.launched).toHaveLength(8)
    // The retry has half the budget; replay keeps both recorded failures.
    expect(run.errors('answer/codex-b')).toEqual(['timed out after 15:00', 'timed out after 7:30'])
    const restored = new WorkflowExecutionService({
      store: run.store,
      slots: new WorkflowScriptSlots(1),
      reservation: 1,
      launch: () => {
        throw new Error('Replay must not launch')
      },
      progress: vi.fn()
    })
    expect(await restored.recoverCompleted(run.id, 1)).toEqual(outcome)
    expect(run.launched).toHaveLength(8)
  })

  it('completes around a ranking that named no response twice', async () => {
    const run = councilRun({ 'rank/codex': ['unranked', 3] })
    const outcome = await run.service.wait(run.id)
    expect(outcome.state).toBe('completed')
    expect((outcome.result as CouncilV6Result).ballots.map((ballot) => ballot.callId)).toEqual([
      'rank/claude',
      'rank/codex-b'
    ])
    expect(run.count('rank/codex')).toBe(2)
  })

  it('retries only the failed chairman; a failed member and ranking stay the same nulls', async () => {
    // Each would answer on its third attempt, which would change the chairman's call identity.
    const run = councilRun({
      'answer/codex-b': ['timeout', 2],
      'rank/codex': ['unranked', 2],
      'chair/final': ['exit', 2]
    })
    expect((await run.service.wait(run.id)).state).toBe('failed')
    expect(run.launched).toHaveLength(10)
    expect(run.retryable()).toBe(true)
    run.store.retryFailed(run.id, 1)
    run.service.resume(run.id, 1)
    const outcome = await run.service.wait(run.id)
    expect(outcome.state).toBe('completed')
    expect(run.launched.slice(10)).toEqual(['chair/final'])
    const result = outcome.result as CouncilV6Result
    expect(result.answers).toHaveLength(2)
    expect(result.ballots.map((ballot) => ballot.callId)).toEqual(['rank/claude', 'rank/codex-b'])
  })

  it('keeps a chairman that failed every attempt failed, with nothing left to retry', async () => {
    const run = councilRun({ 'chair/final': ['exit', 3] })
    expect((await run.service.wait(run.id)).state).toBe('failed')
    run.store.retryFailed(run.id, 1)
    run.service.resume(run.id, 1)
    expect((await run.service.wait(run.id)).state).toBe('failed')
    expect(run.count('chair/final')).toBe(3)
    expect(run.retryable()).toBe(false)
    expect(() => run.store.retryFailed(run.id, 1)).toThrow('no remaining attempt')
  })

  it('still fails when no member answers, and Retry asks the members again', async () => {
    const run = councilRun({
      'answer/claude': ['exit', 2],
      'answer/codex': ['exit', 2],
      'answer/codex-b': ['timeout', 2]
    })
    const failed = await run.service.wait(run.id)
    expect(failed).toMatchObject({
      state: 'failed',
      error: 'No council member answered the question.'
    })
    expect(run.retryable()).toBe(true)
    run.store.retryFailed(run.id, 1)
    run.service.resume(run.id, 1)
    const outcome = await run.service.wait(run.id)
    expect(outcome.state).toBe('completed')
    expect((outcome.result as CouncilV6Result).answers).toHaveLength(3)
  })

  it('keeps a failed member null when a pause lands after the rankings began', async () => {
    let paused = false
    const run = councilRun({ 'answer/codex-b': ['timeout', 2] }, (input, service, id) => {
      if (!paused && input.call.id.startsWith('rank/')) {
        paused = true
        service.control(id, 1, 'pause')
      }
    })
    expect((await run.service.wait(run.id)).state).toBe('paused')
    expect(run.launched.filter((callId) => callId.startsWith('rank/'))).toEqual(['rank/claude'])
    run.service.resume(run.id, 1)
    const outcome = await run.service.wait(run.id)
    expect(outcome.state).toBe('completed')
    // The accepted ranking was keyed on two answers, so the third attempt never runs.
    expect(run.count('answer/codex-b')).toBe(2)
    expect(run.count('rank/claude')).toBe(1)
    expect((outcome.result as CouncilV6Result).ballots).toHaveLength(3)
  })
})
