import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import { createRootDispatch } from '../orchestration/db/root-dispatch-test-fixture'
import type { OrchestrationCaller } from '../build-review/build-review-rpc-call'
import { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import {
  acceptWorkingAgentResult,
  getWorkingAgentCallForDispatch,
  markWorkingAgentStartInFlight,
  prepareWorkingAgentCall
} from './workflow-working-agent-calls'
import { executeWorkingAgentCall } from './workflow-working-agent-executor'
import type { WorkflowProgramCall } from './workflow-program-context'

const opened: OrchestrationDb[] = []
afterEach(() => opened.splice(0).forEach((db) => db.close()))

function fixture(
  options: { lostStartReceipt?: boolean; noEffectReceipt?: boolean; failedStart?: boolean } = {}
) {
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
  const run = db.createRun({
    objective: 'Build HTML',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  })
  const call: WorkflowProgramCall = {
    id: 'answers/seat-1',
    prompt: 'Build index.html.',
    schema: {
      type: 'object',
      properties: { markdown: { type: 'string' } },
      required: ['markdown'],
      additionalProperties: false
    },
    seatId: 'seat-1',
    dependencies: [],
    semantic: { kind: 'none' },
    validateSemantics: () => null
  }
  const answer = { markdown: 'Built the page in my private worktree.' }
  let taskId: string | undefined
  let dispatchId: string | undefined
  let startRequestId: string | undefined
  const calls: { method: string; params: Record<string, unknown>; requestId?: string }[] = []
  const callRpc: OrchestrationCaller = async <T>(
    method: string,
    params: Record<string, unknown>,
    callOptions?: { requestId?: string }
  ): Promise<T> => {
    calls.push({ method, params, requestId: callOptions?.requestId })
    if (method === 'orchestration.taskCreate') {
      taskId ??= db.createTask({ runId: run.id, spec: String(params.spec) }).id
      return { task: { id: taskId } } as T
    }
    if (method === 'orchestration.workerStart') {
      startRequestId = callOptions?.requestId
      if (!options.noEffectReceipt) {
        dispatchId = createRootDispatch(db, taskId!, 'term_worker').id
        db.db
          .prepare('UPDATE local_workflow_worker_calls SET child_worktree_id=? WHERE task_id=?')
          .run('repo::/private-child', taskId!)
        expect(acceptWorkingAgentResult(db, dispatchId, answer, 'c'.repeat(64))).toEqual({
          accepted: true
        })
        db.db.prepare("UPDATE tasks SET status='completed' WHERE id=?").run(taskId!)
      }
      if (options.lostStartReceipt || options.noEffectReceipt) {
        throw new Error('transport lost after workerStart')
      }
      return {
        dispatchId,
        state: options.failedStart ? 'failed' : 'ready',
        lastError: 'startup failed'
      } as T
    }
    if (method === 'orchestration.requestShow') {
      return {
        state: options.noEffectReceipt ? 'absent' : 'pending',
        receipt: options.noEffectReceipt ? undefined : { accepted: { dispatchId } }
      } as T
    }
    if (method === 'orchestration.workerRelease') {
      return { state: 'released' } as T
    }
    if (method === 'orchestration.workerStop') {
      return { state: 'stopped' } as T
    }
    throw new Error(`Unexpected RPC ${method}`)
  }
  const input = {
    db,
    callRpc,
    executionId,
    runId: run.id,
    coordinatorTerminalHandle: 'term_coord',
    workspaceId: 'repo::/clean-project',
    sourceBase: 'a'.repeat(40),
    sourceDiffDigest: 'b'.repeat(64),
    seat: {
      id: 'seat-1',
      agent: 'claude' as const,
      accountId: 'managed:claude',
      model: 'claude-opus',
      effort: 'high',
      lineage: 'anthropic' as const,
      policyRevision: 'test-v1'
    },
    call,
    signal: new AbortController().signal,
    pollMs: 1,
    deadlineMs: 1000,
    captureArtifacts: async () => ({ digest: 'c'.repeat(64) })
  }
  return {
    db,
    call,
    calls,
    input,
    answer,
    get taskId() {
      return taskId
    },
    get dispatchId() {
      return dispatchId
    },
    get startRequestId() {
      return startRequestId
    }
  }
}

describe('working-agent orchestration executor', () => {
  it('uses the original writable worker path in one child worktree and returns accepted JSON', async () => {
    const f = fixture()
    expect(await executeWorkingAgentCall(f.input)).toEqual(f.answer)
    const starts = f.calls.filter((call) => call.method === 'orchestration.workerStart')
    expect(starts).toHaveLength(1)
    expect(starts[0].params).toMatchObject({
      worktree: 'new-child',
      baseBranch: 'a'.repeat(40),
      agent: 'claude',
      accountChoiceId: 'managed:claude',
      model: 'claude-opus',
      effort: 'high',
      permissionMode: 'yolo'
    })
    expect(String(starts[0].params.executionBrief)).toContain(
      'result-submit --dispatch <your Dispatch ID> --file <that JSON file> --dispatch-capability <your Dispatch capability>'
    )
    expect(f.calls.map((call) => call.method)).toContain('orchestration.workerRelease')
    expect(getWorkingAgentCallForDispatch(f.db, f.dispatchId!)?.state).toBe('accepted')
    expect(await executeWorkingAgentCall(f.input)).toEqual(f.answer)
    expect(f.calls.filter((call) => call.method === 'orchestration.workerStart')).toHaveLength(1)
  })

  it('adopts an accepted Dispatch after a lost workerStart response without launching twice', async () => {
    const f = fixture({ lostStartReceipt: true })
    expect(await executeWorkingAgentCall(f.input)).toEqual(f.answer)
    expect(f.calls.filter((call) => call.method === 'orchestration.workerStart')).toHaveLength(1)
    expect(f.calls.find((call) => call.method === 'orchestration.requestShow')?.params).toEqual({
      request: f.startRequestId
    })
  })

  it('uses the verified system account as the default launch account', async () => {
    const f = fixture()
    f.input.seat.accountId = 'system:claude'
    expect(await executeWorkingAgentCall(f.input)).toEqual(f.answer)
    expect(
      f.calls.find((call) => call.method === 'orchestration.workerStart')?.params
    ).not.toHaveProperty('accountChoiceId')
  })

  it('releases a receipted Dispatch when worker startup fails', async () => {
    const f = fixture({ failedStart: true })
    await expect(executeWorkingAgentCall(f.input)).rejects.toThrow('startup failed')
    expect(f.calls.map((call) => call.method)).toContain('orchestration.workerStop')
    expect(f.calls.map((call) => call.method)).toContain('orchestration.workerRelease')
    expect(f.calls.filter((call) => call.method === 'orchestration.workerStart')).toHaveLength(1)
  })

  it('keeps an unknown-effect start fenced and does not retry a writable worker', async () => {
    const f = fixture({ noEffectReceipt: true })
    await expect(executeWorkingAgentCall(f.input)).rejects.toThrow(/manual effect reconciliation/)
    await expect(executeWorkingAgentCall(f.input)).rejects.toThrow(/manual effect reconciliation/)
    expect(f.calls.filter((call) => call.method === 'orchestration.workerStart')).toHaveLength(1)
  })

  it('waits for worker_done after a submitted result and never relaunches on restart', async () => {
    const f = fixture()
    const task = f.db.createTask({ runId: f.input.runId, spec: 'Existing writable call' })
    prepareWorkingAgentCall(f.db, {
      executionId: f.input.executionId,
      runId: f.input.runId,
      taskId: task.id,
      workspaceId: f.input.workspaceId,
      sourceBase: f.input.sourceBase,
      sourceDiffDigest: f.input.sourceDiffDigest,
      seatFingerprint: JSON.stringify(f.input.seat),
      call: f.call
    })
    markWorkingAgentStartInFlight(f.db, f.input.executionId, f.call.id)
    const dispatch = createRootDispatch(f.db, task.id, 'term_worker')
    f.db.db
      .prepare('UPDATE local_workflow_worker_calls SET child_worktree_id=? WHERE task_id=?')
      .run('repo::/private-child', task.id)
    expect(acceptWorkingAgentResult(f.db, dispatch.id, f.answer, 'c'.repeat(64))).toEqual({
      accepted: true
    })
    const originalCallRpc = f.input.callRpc
    f.input.callRpc = async <T>(
      method: string,
      params: Record<string, unknown>,
      options?: { requestId?: string }
    ) =>
      method === 'orchestration.taskCreate'
        ? ({ task: { id: task.id } } as T)
        : originalCallRpc<T>(method, params, options)
    let resolved = false
    const promise = executeWorkingAgentCall(f.input).then((value) => {
      resolved = true
      return value
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(resolved).toBe(false)
    expect(f.calls.filter((call) => call.method === 'orchestration.workerStart')).toHaveLength(0)
    f.db.db.prepare("UPDATE tasks SET status='completed' WHERE id=?").run(task.id)
    expect(await promise).toEqual(f.answer)
    expect(f.calls.filter((call) => call.method === 'orchestration.workerRelease')).toHaveLength(1)
  })

  it('fails closed if the child files change after result-submit', async () => {
    const f = fixture()
    f.input.captureArtifacts = async () => ({ digest: 'd'.repeat(64) })
    await expect(executeWorkingAgentCall(f.input)).rejects.toThrow(/artifacts changed/)
    expect(f.calls.filter((call) => call.method === 'orchestration.workerStart')).toHaveLength(1)
    expect(f.calls.filter((call) => call.method === 'orchestration.workerRelease')).toHaveLength(1)
  })
})
