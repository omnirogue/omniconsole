import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import { createRootDispatch } from '../orchestration/db/root-dispatch-test-fixture'
import { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import {
  acceptWorkingAgentResult,
  markWorkingAgentStartInFlight,
  prepareWorkingAgentCall
} from './workflow-working-agent-calls'
import {
  bindWorkingRun,
  finishWorkingRun,
  getWorkingRun,
  markWorkingRunStartInFlight,
  prepareWorkingRun
} from './workflow-working-run-binding'

const opened: OrchestrationDb[] = []
afterEach(() => opened.splice(0).forEach((db) => db.close()))

function fixture() {
  const db = new OrchestrationDb(':memory:')
  opened.push(db)
  const executionId = new WorkflowCheckpointStore(db.db).create({
    conversationId: 'conversation',
    requestId: 'request',
    snapshot: { version: 1, capability: { mode: 'working-agent', revision: 1 } },
    preset: 'council',
    fence: 1,
    attemptLimit: 1,
    callLimit: 7,
    budgetLimit: 7
  })
  const input = {
    executionId,
    workspaceId: 'repo::/source',
    coordinatorHandle: 'term_coord',
    sourceBase: 'a'.repeat(40),
    sourceDiffDigest: 'b'.repeat(64)
  }
  return { db, executionId, input }
}

describe('working Run effect and result ledger', () => {
  it('persists one runCreate request and refuses identity changes or ambiguous retries', () => {
    const f = fixture()
    const prepared = prepareWorkingRun(f.db, f.input)
    expect(prepared.run_request_id).toMatch(/^[a-f0-9-]{36}$/)
    expect(prepareWorkingRun(f.db, f.input).run_request_id).toBe(prepared.run_request_id)
    expect(() => prepareWorkingRun(f.db, { ...f.input, sourceBase: 'c'.repeat(40) })).toThrow(
      /identity changed/
    )
    expect(markWorkingRunStartInFlight(f.db, f.executionId).state).toBe('starting')
    expect(() => markWorkingRunStartInFlight(f.db, f.executionId)).toThrow(/reconciliation/)
    const run = f.db.createRun({
      objective: 'Council',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    expect(bindWorkingRun(f.db, f.executionId, run.id).run_id).toBe(run.id)
    expect(bindWorkingRun(f.db, f.executionId, run.id).state).toBe('running')
  })

  it('refuses completion until accepted result, worker_done, and release are all recorded', () => {
    const f = fixture()
    prepareWorkingRun(f.db, f.input)
    markWorkingRunStartInFlight(f.db, f.executionId)
    const run = f.db.createRun({
      objective: 'Council',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    bindWorkingRun(f.db, f.executionId, run.id)
    expect(() => finishWorkingRun(f.db, f.executionId, 1, { markdown: 'done' })).toThrow(
      /unresolved/
    )
    const task = f.db.createTask({ runId: run.id, spec: 'Peer review' })
    prepareWorkingAgentCall(f.db, {
      executionId: f.executionId,
      runId: run.id,
      taskId: task.id,
      workspaceId: f.input.workspaceId,
      sourceBase: f.input.sourceBase,
      sourceDiffDigest: f.input.sourceDiffDigest,
      seatFingerprint: 'seat:model:account',
      call: {
        id: 'peer/seat-1',
        seatId: 'seat-1',
        dependencies: [],
        prompt: 'Rank',
        schema: {
          type: 'object',
          properties: { ranking: { type: 'array' } },
          required: ['ranking']
        },
        semantic: { kind: 'none' },
        validateSemantics: () => null
      }
    })
    markWorkingAgentStartInFlight(f.db, f.executionId, 'peer/seat-1')
    const dispatch = createRootDispatch(f.db, task.id, 'term_worker')
    f.db.createWorkerTerminalResourceStatement({
      dispatchId: dispatch.id,
      worktreeId: 'repo::/child',
      terminalHandle: 'term_worker',
      paneKey: null,
      processIncarnation: null,
      ownership: 'owned'
    })
    expect(acceptWorkingAgentResult(f.db, dispatch.id, { ranking: [] })).toEqual({ accepted: true })
    expect(() => finishWorkingRun(f.db, f.executionId, 1, { markdown: 'done' })).toThrow(
      /unresolved/
    )
    f.db.db.prepare("UPDATE tasks SET status='completed' WHERE id=?").run(task.id)
    expect(() => finishWorkingRun(f.db, f.executionId, 1, { markdown: 'done' })).toThrow(
      /unresolved/
    )
    f.db.db
      .prepare(
        "UPDATE worker_terminal_resources SET release_state='released' WHERE owner_dispatch_id=?"
      )
      .run(dispatch.id)
    const done = finishWorkingRun(f.db, f.executionId, 1, { markdown: 'done' })
    expect(done.state).toBe('completed')
    expect(done.result_digest).toMatch(/^[a-f0-9]{64}$/)
    expect(getWorkingRun(f.db, f.executionId)?.result_json).toBe('{"markdown":"done"}')
  })
})
