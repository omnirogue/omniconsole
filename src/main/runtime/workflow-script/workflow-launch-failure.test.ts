import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import {
  createDurableWorkflowAgent,
  WorkflowNoLaunchError,
  type WorkflowAttemptLaunch
} from './workflow-durable-call'
import {
  WorkflowCallLaunchError,
  workflowAccountFailure,
  workflowCallLaunchFailure
} from './workflow-launch-failure'
import type { WorkflowProgramCall } from './workflow-program-context'
import { WorkflowScriptSlots } from './workflow-script-slots'

const databases: OrchestrationDb[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

const call: WorkflowProgramCall = {
  id: 'verify/r1/find.r1.1/a0',
  seatId: 'codex',
  prompt: 'Check it',
  dependencies: [],
  schema: {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false
  },
  validateSemantics: (value) =>
    (value as { answer: string }).answer === 'correct' ? null : 'unsupported answer'
}

function run(launch: WorkflowAttemptLaunch) {
  const database = new OrchestrationDb(':memory:')
  databases.push(database)
  const store = new WorkflowCheckpointStore(database.db)
  const executionId = store.create({
    conversationId: 'conversation',
    requestId: 'request',
    snapshot: {},
    preset: 'council',
    fence: 1,
    attemptLimit: 3,
    callLimit: 7,
    budgetLimit: 30
  })
  const controller = new AbortController()
  const agent = createDurableWorkflowAgent({
    store,
    executionId,
    fence: 1,
    slots: new WorkflowScriptSlots(1),
    signal: controller.signal,
    reservation: 10,
    attemptsPerRun: 2,
    seatFingerprint: () => 'claude:model:account:policy',
    route: () => 'claude',
    launch,
    closeAdmission: (error: Error) => controller.abort(error)
  })
  const attempts = () =>
    database.db
      .prepare('SELECT state, receipt_json FROM local_workflow_attempts ORDER BY ordinal')
      .all() as { state: string; receipt_json: string | null }[]
  return { agent, attempts }
}

/** A Claude process that exited at once with `stdout`, the way a usage limit ends it. */
function exited(attemptId: string, stdout: string, code = 1) {
  return {
    result: { code, signal: null, timedOut: false, stderr: '', stdout },
    receipt: { attemptId, processReceiptRef: attemptId, liveness: 'exited' as const }
  }
}

const LIMIT_RESULT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: true,
  result: 'Claude AI usage limit reached|1790000000',
  session_id: 's'
})

describe('a call that failed at launch', () => {
  it('is one where no process ever launched', async () => {
    const f = run(async ({ recordNoLaunch }) => {
      recordNoLaunch('The selected Codex account is unavailable.')
      throw new WorkflowNoLaunchError('The selected Codex account is unavailable.')
    })
    await expect(f.agent(call)).rejects.toBeInstanceOf(WorkflowCallLaunchError)
    expect(workflowCallLaunchFailure(f.attempts())).toBe(
      'The selected Codex account is unavailable.'
    )
  })

  it('is one whose process the provider stopped on the account (a usage limit)', async () => {
    const f = run(async ({ attemptId, recordLaunch }) => {
      recordLaunch(attemptId)
      return exited(attemptId, LIMIT_RESULT)
    })
    const failure = await f.agent(call).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WorkflowCallLaunchError)
    expect((failure as Error).message).toContain('usage limit reached')
    expect(workflowCallLaunchFailure(f.attempts())).toContain('usage limit reached')
  })

  it('is never one that ran and failed on its answer, or timed out', async () => {
    const rejected = run(async ({ attemptId, recordLaunch }) => {
      recordLaunch(attemptId)
      return exited(
        attemptId,
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: attemptId,
          structured_output: { answer: 'wrong' },
          modelUsage: { 'claude-model': {} },
          usage: {}
        }),
        0
      )
    })
    const failure = await rejected.agent(call).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(WorkflowCallLaunchError)
    expect(workflowCallLaunchFailure(rejected.attempts())).toBeUndefined()
    // A timeout before the quota hit means the call did run; it stays a non-launch failure.
    let ordinal = 0
    const mixed = run(async ({ attemptId, recordLaunch }) => {
      recordLaunch(attemptId)
      return ++ordinal === 1
        ? { ...exited(attemptId, ''), result: { ...exited(attemptId, '').result, timedOut: true } }
        : exited(attemptId, LIMIT_RESULT)
    })
    await expect(mixed.agent(call)).rejects.not.toBeInstanceOf(WorkflowCallLaunchError)
    expect(ordinal).toBe(2)
    expect(workflowCallLaunchFailure(mixed.attempts())).toBeUndefined()
  })

  it('reads the account out of process failures only', () => {
    expect(
      workflowAccountFailure(
        "workflow provider reported a failed turn: You've hit your usage limit. Try again later."
      )
    ).toBe(true)
    expect(
      workflowAccountFailure(
        'workflow process did not complete successfully (exit 1): Invalid API key · Please run /login'
      )
    ).toBe(true)
    expect(workflowAccountFailure('workflow process did not complete successfully (exit 1)')).toBe(
      false
    )
    // The model's own words about quotas are content, never the account's failure.
    expect(workflowAccountFailure('the answer is not valid JSON (quota exceeded)')).toBe(false)
    expect(workflowAccountFailure('timed out after 15:00')).toBe(false)
  })
})
