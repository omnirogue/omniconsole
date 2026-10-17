import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import { createRootDispatch } from '../orchestration/db/root-dispatch-test-fixture'
import { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import {
  acceptWorkingAgentResult,
  bindWorkingAgentDispatch,
  getWorkingAgentCallForDispatch,
  markWorkingAgentStartInFlight,
  prepareWorkingAgentCall
} from './workflow-working-agent-calls'
import type { WorkflowProgramCall } from './workflow-program-context'

const opened: OrchestrationDb[] = []
afterEach(() => opened.splice(0).forEach((db) => db.close()))

function fixture(capability: 'working-agent' | 'frozen-analysis' = 'working-agent') {
  const db = new OrchestrationDb(':memory:')
  opened.push(db)
  const store = new WorkflowCheckpointStore(db.db)
  const executionId = store.create({
    conversationId: 'c',
    requestId: 'r',
    snapshot: { version: 1, capability: { mode: capability, revision: 1 } },
    preset: 'council',
    fence: 1,
    attemptLimit: 1,
    callLimit: 7,
    budgetLimit: 7
  })
  const run = db.createRun({
    objective: 'Council',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  })
  const task = db.createTask({ runId: run.id, spec: 'Blind peer review' })
  const call: WorkflowProgramCall = {
    id: 'peer/seat-1',
    prompt: 'Rank two anonymous responses.',
    schema: {
      type: 'object',
      properties: {
        ranking: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 }
      },
      required: ['ranking'],
      additionalProperties: true
    },
    seatId: 'seat-1',
    dependencies: ['answers/seat-2', 'answers/seat-3'],
    semantic: { kind: 'council-ballot', expectedLabels: ['Response B', 'Response C'] },
    validateSemantics: () => null
  }
  const input = {
    executionId,
    runId: run.id,
    taskId: task.id,
    workspaceId: 'repo::/test',
    sourceBase: 'a'.repeat(40),
    sourceDiffDigest: 'b'.repeat(64),
    seatFingerprint: 'claude:model:account',
    call
  }
  return { db, run, task, input }
}

const valid = {
  ranking: ['Response B', 'Response C'],
  assessments: [
    { label: 'Response B', strengths: 'Good', weaknesses: 'Limited' },
    { label: 'Response C', strengths: 'Strong', weaknesses: 'Risk' }
  ]
}

describe('working-agent Task and Dispatch result boundary', () => {
  it('pins source, seat, schema, semantics, and one start request before launch', () => {
    const f = fixture()
    const prepared = prepareWorkingAgentCall(f.db, f.input)
    expect(prepared.state).toBe('prepared')
    expect(prepared.start_request_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(prepareWorkingAgentCall(f.db, f.input).start_request_id).toBe(prepared.start_request_id)
    expect(() => prepareWorkingAgentCall(f.db, { ...f.input, sourceBase: 'c'.repeat(40) })).toThrow(
      /identity changed/
    )
    expect(markWorkingAgentStartInFlight(f.db, f.input.executionId, f.input.call.id).state).toBe(
      'starting'
    )
    expect(() => markWorkingAgentStartInFlight(f.db, f.input.executionId, f.input.call.id)).toThrow(
      /reconciliation/
    )
  })

  it('validates in the original Dispatch, including ballot semantics, before acceptance', () => {
    const f = fixture()
    prepareWorkingAgentCall(f.db, f.input)
    markWorkingAgentStartInFlight(f.db, f.input.executionId, f.input.call.id)
    const dispatch = createRootDispatch(f.db, f.task.id, 'term_worker')
    expect(getWorkingAgentCallForDispatch(f.db, dispatch.id)?.task_id).toBe(f.task.id)
    expect(acceptWorkingAgentResult(f.db, dispatch.id, { ranking: [] })).toMatchObject({
      accepted: false,
      problems: expect.stringMatching(/at least 2/)
    })
    expect(
      acceptWorkingAgentResult(f.db, dispatch.id, {
        ...valid,
        ranking: ['Response B', 'Response B']
      })
    ).toMatchObject({ accepted: false, problems: expect.stringMatching(/exactly once/) })
    expect(getWorkingAgentCallForDispatch(f.db, dispatch.id)?.state).toBe('starting')
    expect(acceptWorkingAgentResult(f.db, dispatch.id, valid)).toEqual({ accepted: true })
    expect(bindWorkingAgentDispatch(f.db, f.task.id, dispatch.id).state).toBe('accepted')
    expect(acceptWorkingAgentResult(f.db, dispatch.id, valid)).toEqual({
      accepted: true,
      duplicate: true
    })
    expect(
      acceptWorkingAgentResult(f.db, dispatch.id, {
        ...valid,
        assessments: valid.assessments.map((entry) => ({ ...entry, strengths: 'Changed' }))
      })
    ).toEqual({ accepted: true })
    expect(getWorkingAgentCallForDispatch(f.db, dispatch.id)?.result_revision).toBe(2)
    expect(acceptWorkingAgentResult(f.db, dispatch.id, { ranking: [] })).toMatchObject({
      accepted: false,
      problems: expect.stringMatching(/at least 2/)
    })
  })

  it('refuses a second Dispatch or a stopped Dispatch for a writable call', () => {
    const f = fixture()
    prepareWorkingAgentCall(f.db, f.input)
    markWorkingAgentStartInFlight(f.db, f.input.executionId, f.input.call.id)
    const first = createRootDispatch(f.db, f.task.id, 'term_first')
    // Simulate a bad external reset to verify the workflow refuses a second Dispatch.
    f.db.db.prepare("UPDATE tasks SET status='ready' WHERE id=?").run(f.task.id)
    const second = createRootDispatch(f.db, f.task.id, 'term_second')
    expect(acceptWorkingAgentResult(f.db, second.id, valid)).toMatchObject({
      accepted: false,
      problems: expect.stringMatching(/another Dispatch/)
    })
    f.db.db.prepare("UPDATE dispatch_contexts SET status='failed' WHERE id=?").run(first.id)
    expect(acceptWorkingAgentResult(f.db, first.id, valid)).toMatchObject({
      accepted: false,
      problems: expect.stringMatching(/no longer active/)
    })
  })

  it('refuses a result after the host execution was cancelled', () => {
    const f = fixture()
    prepareWorkingAgentCall(f.db, f.input)
    markWorkingAgentStartInFlight(f.db, f.input.executionId, f.input.call.id)
    const dispatch = createRootDispatch(f.db, f.task.id, 'term_worker')
    f.db.db
      .prepare("UPDATE local_workflow_executions SET state='cancelled' WHERE id=?")
      .run(f.input.executionId)
    expect(acceptWorkingAgentResult(f.db, dispatch.id, valid)).toMatchObject({
      accepted: false,
      problems: expect.stringContaining('execution is stopped')
    })
    expect(getWorkingAgentCallForDispatch(f.db, dispatch.id)?.state).toBe('starting')
  })

  it('refuses successful worker_done after cancellation, even with an earlier accepted result', () => {
    const f = fixture()
    prepareWorkingAgentCall(f.db, f.input)
    markWorkingAgentStartInFlight(f.db, f.input.executionId, f.input.call.id)
    const dispatch = createRootDispatch(f.db, f.task.id, 'term_worker')
    expect(acceptWorkingAgentResult(f.db, dispatch.id, valid)).toMatchObject({ accepted: true })
    f.db.db
      .prepare("UPDATE local_workflow_executions SET state='cancelled' WHERE id=?")
      .run(f.input.executionId)
    expect(
      f.db.settleWorkerReport({
        taskId: f.task.id,
        dispatchId: dispatch.id,
        outcome: 'succeeded',
        result: 'done'
      })
    ).toMatchObject({ action: 'rejected', code: 'structured_result_required' })
  })

  it('refuses an old frozen-analysis checkpoint even when a Task exists', () => {
    const f = fixture('frozen-analysis')
    expect(() => prepareWorkingAgentCall(f.db, f.input)).toThrow(/did not admit/)
    expect(
      f.db.db.prepare('SELECT COUNT(*) AS count FROM local_workflow_worker_calls').get()
    ).toMatchObject({ count: 0 })
  })

  it('rejects semantic contract tampering before accepting a successful worker result', () => {
    const f = fixture()
    prepareWorkingAgentCall(f.db, f.input)
    markWorkingAgentStartInFlight(f.db, f.input.executionId, f.input.call.id)
    const dispatch = createRootDispatch(f.db, f.task.id, 'term_worker')
    f.db.db
      .prepare('UPDATE local_workflow_worker_calls SET semantic_json=? WHERE task_id=?')
      .run(JSON.stringify({ kind: 'none' }), f.task.id)
    expect(() => acceptWorkingAgentResult(f.db, dispatch.id, valid)).toThrow(
      /semantic evidence changed/
    )
    expect(getWorkingAgentCallForDispatch(f.db, dispatch.id)?.state).toBe('starting')
  })

  it('keeps worker_done closed if accepted answer evidence lacks a captured artifact digest', () => {
    const f = fixture()
    const answerCall: WorkflowProgramCall = {
      ...f.input.call,
      id: 'answers/seat-1',
      semantic: { kind: 'none' },
      dependencies: []
    }
    prepareWorkingAgentCall(f.db, { ...f.input, call: answerCall })
    markWorkingAgentStartInFlight(f.db, f.input.executionId, answerCall.id)
    const dispatch = createRootDispatch(f.db, f.task.id, 'term_worker')
    const resultJson = JSON.stringify({ ranking: [] })
    const digest = createHash('sha256').update(resultJson).digest('hex')
    f.db.db
      .prepare(`UPDATE local_workflow_worker_calls
        SET state='accepted',dispatch_id=?,result_json=?,result_digest=? WHERE task_id=?`)
      .run(dispatch.id, resultJson, digest, f.task.id)
    expect(
      f.db.settleWorkerReport({
        taskId: f.task.id,
        dispatchId: dispatch.id,
        outcome: 'succeeded',
        result: 'done'
      })
    ).toMatchObject({ action: 'rejected', code: 'structured_result_required' })
    f.db.db
      .prepare('UPDATE local_workflow_worker_calls SET artifact_digest=? WHERE task_id=?')
      .run('e'.repeat(64), f.task.id)
    expect(
      f.db.settleWorkerReport({
        taskId: f.task.id,
        dispatchId: dispatch.id,
        outcome: 'succeeded',
        result: 'done'
      })
    ).toMatchObject({ action: 'settled' })
  })
})
