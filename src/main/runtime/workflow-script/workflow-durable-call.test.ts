import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import {
  createDurableWorkflowAgent,
  WorkflowAttemptUnverifiableError,
  WorkflowHostLostError,
  WorkflowNoLaunchError,
  type WorkflowAttemptLaunch
} from './workflow-durable-call'
import { WORKFLOW_CALL_STALL_MS } from './workflow-call-timeout'
import { WorkflowScriptSlots } from './workflow-script-slots'
import type { WorkflowProgramCall } from './workflow-program-context'

const databases: OrchestrationDb[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const db of databases.splice(0)) {
    db.close()
  }
})
const call: WorkflowProgramCall = {
  id: 'answers/a',
  seatId: 'a',
  prompt: 'Frozen question',
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
function setup(launch: WorkflowAttemptLaunch, attemptLimit = 3) {
  const database = new OrchestrationDb(':memory:')
  databases.push(database)
  const store = new WorkflowCheckpointStore(database.db)
  const executionId = store.create({
    conversationId: 'conversation',
    requestId: 'request',
    snapshot: {},
    preset: 'council',
    fence: 1,
    attemptLimit,
    callLimit: 7,
    budgetLimit: 30
  })
  const controller = new AbortController()
  const slots = new WorkflowScriptSlots(1)
  const config = {
    store,
    executionId,
    fence: 1,
    slots,
    signal: controller.signal,
    reservation: 10,
    seatFingerprint: () => 'claude:exact-model:high:account-1:policy-1:validator-1',
    route: () => 'claude' as const,
    launch,
    closeAdmission: (error: Error) => controller.abort(error)
  }
  return { database, store, config, controller, agent: createDurableWorkflowAgent(config) }
}
function response(attemptId: string, value: unknown, overflow = false) {
  return {
    result: {
      code: 0,
      signal: null,
      timedOut: false,
      stderr: '',
      ...(overflow ? { stdoutTruncated: true as const } : {}),
      stdout: JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: attemptId,
        structured_output: value,
        modelUsage: { 'claude-model': {} },
        usage: { input_tokens: 1 }
      })
    },
    receipt: { attemptId, processReceiptRef: attemptId, liveness: 'exited' as const }
  }
}

/** What the launch returns once it ended a call whose output went silent. */
function stalled(attemptId: string) {
  const answer = response(attemptId, { answer: 'correct' })
  return {
    ...answer,
    result: {
      ...answer.result,
      code: null,
      signal: 'SIGTERM' as const,
      stdout: '',
      stalledAfterMs: WORKFLOW_CALL_STALL_MS
    }
  }
}
const LOST = 'Lost contact with mw0001 while answers/a ran there (ssh: Connection reset by peer).'
const LOST_STOPPED = `${LOST} Its seat process there is exited. The run stopped; nothing moved to this computer.`
const LOST_RETRYING = `${LOST} Its seat process there is exited. Retrying it there once; nothing moved to this computer.`
function hostLost(attemptId: string, retry = true) {
  const launched = {
    result: { code: 255, signal: null, timedOut: false, stdout: '', stderr: 'reset' },
    receipt: { attemptId, processReceiptRef: attemptId, liveness: 'exited' as const }
  }
  return new WorkflowHostLostError(LOST_STOPPED, launched, retry ? LOST_RETRYING : undefined)
}
function settled(f: ReturnType<typeof setup>) {
  return (
    f.database.db
      .prepare('SELECT state, receipt_json FROM local_workflow_attempts ORDER BY ordinal')
      .all() as { state: string; receipt_json: string }[]
  ).map((row) => ({ state: row.state, error: JSON.parse(row.receipt_json).error }))
}

describe('durable workflow call execution', () => {
  it('commits native validated evidence and replays it through a new controller without launch', async () => {
    let launches = 0
    const f = setup(async ({ attemptId, recordLaunch }) => {
      launches++
      recordLaunch(attemptId)
      return response(attemptId, { answer: 'correct' })
    })
    expect(await f.agent(call)).toEqual({ answer: 'correct' })
    expect(await createDurableWorkflowAgent(f.config)(call)).toEqual({ answer: 'correct' })
    expect(launches).toBe(1)
    const row = f.database.db
      .prepare('SELECT state, receipt_json FROM local_workflow_attempts')
      .get() as { state: string; receipt_json: string }
    expect(row.state).toBe('accepted')
    expect(JSON.parse(row.receipt_json)).toMatchObject({ usage: { input_tokens: 1 } })
  })

  it('persists rejected overflow and semantic attempts before a corrected result', async () => {
    const corrections: (string | null)[] = []
    const f = setup(async ({ attemptId, ordinal, problems, recordLaunch }) => {
      corrections.push(problems)
      recordLaunch(attemptId)
      return response(attemptId, { answer: ordinal === 2 ? 'wrong' : 'correct' }, ordinal === 1)
    })
    expect(await f.agent(call)).toEqual({ answer: 'correct' })
    expect(corrections).toEqual([null, 'workflow output overflow', 'unsupported answer'])
    expect(
      f.database.db.prepare('SELECT state FROM local_workflow_attempts ORDER BY ordinal').all()
    ).toEqual([{ state: 'failed' }, { state: 'failed' }, { state: 'accepted' }])
    expect(
      f.database.db.prepare('SELECT budget_reserved FROM local_workflow_executions').get()
    ).toMatchObject({ budget_reserved: 30 })
  })

  it('shows a retry only why the last answer was rejected, never an infrastructure fault', async () => {
    const rejections: (string | null | undefined)[] = []
    const f = setup(async ({ attemptId, ordinal, rejection, recordLaunch }) => {
      rejections.push(rejection)
      recordLaunch(attemptId)
      return response(attemptId, { answer: ordinal === 1 ? 'wrong' : 'correct' }, ordinal === 2)
    })
    expect(await f.agent(call)).toEqual({ answer: 'correct' })
    // Attempt 2 overflowed (the host's problem), so attempt 3 still hears about attempt 1.
    expect(rejections).toEqual([null, 'unsupported answer', 'unsupported answer'])
  })

  it('does not spawn or prepare a queued sibling after unknown launch failure', async () => {
    let launches = 0
    const f = setup(async () => {
      launches++
      throw new Error('lost process handle')
    })
    const results = await Promise.allSettled([f.agent(call), f.agent({ ...call, id: 'answers/b' })])
    expect(
      results.every(
        (result) =>
          result.status === 'rejected' && result.reason instanceof WorkflowAttemptUnverifiableError
      )
    ).toBe(true)
    expect(launches).toBe(1)
    expect(f.database.db.prepare('SELECT state FROM local_workflow_attempts').all()).toEqual([
      { state: 'prepared' }
    ])
    expect(f.config.slots.running).toBe(0)
    expect(f.config.slots.queued).toBe(0)
  })

  it('retains terminal failure evidence when all attempts are exhausted', async () => {
    const f = setup(async ({ attemptId, recordLaunch }) => {
      recordLaunch(attemptId)
      return response(attemptId, { answer: 'wrong' })
    })
    await expect(f.agent(call)).rejects.toThrow('exhausted its attempts')
    expect(
      f.database.db
        .prepare("SELECT COUNT(*) AS count FROM local_workflow_attempts WHERE state='failed'")
        .get()
    ).toMatchObject({ count: 3 })
    await expect(f.agent(call)).rejects.toThrow('Persisted attempt budget exhausted')
  })

  it('settles a proven prelaunch failure without pretending a process exited', async () => {
    const f = setup(async ({ recordNoLaunch }) => {
      recordNoLaunch('Selected account input could not be prepared')
      throw new WorkflowNoLaunchError('Selected account input could not be prepared')
    })
    await expect(f.agent(call)).rejects.toThrow('exhausted its attempts')
    expect(f.controller.signal.aborted).toBe(false)
    expect(f.store.pendingAttempts(f.config.executionId, 1)).toEqual([])
    expect(
      f.database.db
        .prepare(
          "SELECT COUNT(*) AS count FROM local_workflow_attempts WHERE state='failed' AND json_extract(receipt_json,'$.noLaunch')=1"
        )
        .get()
    ).toMatchObject({ count: 3 })
    expect(
      f.database.db.prepare('SELECT budget_reserved FROM local_workflow_executions').get()
    ).toMatchObject({ budget_reserved: 30 })
  })

  it('rejects a changed model identity instead of reusing an old answer', async () => {
    const f = setup(async ({ attemptId, recordLaunch }) => {
      recordLaunch(attemptId)
      return response(attemptId, { answer: 'correct' })
    })
    await f.agent(call)
    const changed = createDurableWorkflowAgent({
      ...f.config,
      seatFingerprint: () => 'different-model'
    })
    await expect(changed(call)).rejects.toThrow('call identity changed')
  })
  it('closes admission on mismatched receipt evidence before a sibling can launch', async () => {
    let launches = 0
    const f = setup(async ({ attemptId, recordLaunch }) => {
      launches++
      recordLaunch(attemptId)
      const result = response(attemptId, { answer: 'correct' })
      result.receipt.processReceiptRef = 'wrong process'
      return result
    })
    const results = await Promise.allSettled([f.agent(call), f.agent({ ...call, id: 'answers/b' })])
    expect(
      results.every(
        (result) =>
          result.status === 'rejected' && result.reason instanceof WorkflowAttemptUnverifiableError
      )
    ).toBe(true)
    expect(launches).toBe(1)
  })

  it('settles a finished process after stop without accepting its late answer', async () => {
    const f = setup(async ({ attemptId, recordLaunch }) => {
      recordLaunch(attemptId)
      f.store.requestControl(f.config.executionId, 1, 'stop')
      return response(attemptId, { answer: 'correct' })
    })
    await expect(f.agent(call)).rejects.toThrow('acceptance rejected')
    expect(
      f.database.db.prepare('SELECT state FROM local_workflow_executions').get()
    ).toMatchObject({ state: 'cancelled' })
    expect(
      f.database.db.prepare('SELECT result_json FROM local_workflow_calls').get()
    ).toMatchObject({ result_json: null })
  })
  it('settles a known exit without accepting an answer after controller cancellation', async () => {
    const f = setup(async ({ attemptId, recordLaunch }) => {
      recordLaunch(attemptId)
      f.controller.abort(new Error('Sibling exit unknown'))
      return response(attemptId, { answer: 'correct' })
    })
    await expect(f.agent(call)).rejects.toThrow('Sibling exit unknown')
    expect(f.database.db.prepare('SELECT state FROM local_workflow_attempts').get()).toMatchObject({
      state: 'failed'
    })
    expect(
      f.database.db.prepare('SELECT result_json FROM local_workflow_calls').get()
    ).toMatchObject({ result_json: null })
  })
  it('refuses unsupported schema constraints before reserving or launching', async () => {
    let launched = false
    const f = setup(async ({ attemptId }) => {
      launched = true
      return response(attemptId, {})
    })
    await expect(
      f.agent({
        ...call,
        schema: {
          ...call.schema,
          properties: { answer: { type: 'string', format: 'email' } }
        } as WorkflowProgramCall['schema']
      })
    ).rejects.toThrow('Unsupported workflow schema')
    expect(launched).toBe(false)
    expect(
      f.database.db.prepare('SELECT COUNT(*) AS count FROM local_workflow_attempts').get()
    ).toMatchObject({ count: 0 })
  })
})

describe('durable workflow call stall and lost host', () => {
  it('retries a stalled call once at once and accepts the retry, keeping both attempts', async () => {
    vi.useFakeTimers()
    const f = setup(async ({ attemptId, ordinal, recordLaunch }) => {
      recordLaunch(attemptId)
      return ordinal === 1 ? stalled(attemptId) : response(attemptId, { answer: 'correct' })
    })
    // Nothing waits on a timer between the attempts: the fake clock never moves.
    expect(await f.agent(call)).toEqual({ answer: 'correct' })
    expect(settled(f)).toEqual([
      { state: 'failed', error: 'stalled: no output for 10:00, so it was ended' },
      { state: 'accepted', error: undefined }
    ])
  })

  it('ends the call when its retry stalls too, with attempts to spare', async () => {
    const launches: number[] = []
    const f = setup(async ({ attemptId, ordinal, recordLaunch }) => {
      launches.push(ordinal)
      recordLaunch(attemptId)
      return stalled(attemptId)
    })
    await expect(f.agent(call)).rejects.toThrow(
      'Workflow call exhausted its attempts: stalled: no output for 10:00, so it was ended'
    )
    expect(launches).toEqual([1, 2])
    expect(settled(f).map((row) => row.state)).toEqual(['failed', 'failed'])
    expect(f.controller.signal.aborted).toBe(false)
  })

  it('fails a lost-host call once without closing admission when its seat is gone', async () => {
    const f = setup(async ({ attemptId, recordLaunch }) => {
      recordLaunch(attemptId)
      throw hostLost(attemptId)
    })
    await expect(f.agent(call)).rejects.toThrow(LOST_STOPPED)
    expect(settled(f)).toEqual([{ state: 'failed', error: LOST_STOPPED }])
    expect(f.controller.signal.aborted).toBe(false)
  })

  it('keeps an unverifiable remote attempt pending and closes admission', async () => {
    const f = setup(async ({ attemptId, recordLaunch }) => {
      recordLaunch(attemptId)
      throw hostLost(attemptId, false)
    })
    await expect(f.agent(call)).rejects.toThrow(LOST_STOPPED)
    expect(settled(f)).toEqual([{ state: 'running', error: undefined }])
    expect(f.controller.signal.aborted).toBe(true)
  })
})

describe('durable workflow call account', () => {
  function accountLaunch(order: string[]) {
    const account = { free: false, release: () => {} }
    const freed = new Promise<void>((resolve) => {
      account.release = () => {
        account.free = true
        resolve()
      }
    })
    const launch: WorkflowAttemptLaunch = async ({ call: current, attemptId, recordLaunch }) => {
      order.push(`launch ${current.id}`)
      recordLaunch(attemptId)
      return response(attemptId, { answer: 'correct' })
    }
    return { account, freed, launch }
  }

  it('gives the slot back while the account is taken, so a waiting call holds nothing', async () => {
    const order: string[] = []
    const { account, freed, launch } = accountLaunch(order)
    const f = setup(launch)
    launch.account = async (current, work) => {
      // Asked with the slot held, so the decision is made just before the attempt.
      order.push(`asked ${current.id} with ${f.config.slots.running} slot`)
      if (current.seatId === 'codex' && !account.free) {
        return { busy: () => freed }
      }
      return { done: await work() }
    }
    const codex = f.agent({ ...call, id: 'answers/codex', seatId: 'codex' })
    await vi.waitFor(() => expect(order).toEqual(['asked answers/codex with 1 slot']))
    // The host has one slot; the call waiting for its account neither occupies it nor reserved
    // an attempt.
    expect(f.config.slots.running).toBe(0)
    expect(
      f.database.db.prepare('SELECT COUNT(*) AS count FROM local_workflow_attempts').get()
    ).toMatchObject({ count: 0 })
    expect(await f.agent({ ...call, id: 'answers/claude' })).toEqual({ answer: 'correct' })
    account.release()
    expect(await codex).toEqual({ answer: 'correct' })
    expect(order).toEqual([
      'asked answers/codex with 1 slot',
      'asked answers/claude with 1 slot',
      'launch answers/claude',
      'asked answers/codex with 1 slot',
      'launch answers/codex'
    ])
    // Waiting for the account used none of the call's attempts.
    expect(
      f.database.db
        .prepare("SELECT ordinal, state FROM local_workflow_attempts WHERE call_id='answers/codex'")
        .all()
    ).toEqual([{ ordinal: 1, state: 'accepted' }])
  })

  it('stops waiting for a taken account when the run is cancelled', async () => {
    const order: string[] = []
    const { launch } = accountLaunch(order)
    const f = setup(launch)
    launch.account = async (_current, _work, signal) => ({
      busy: () =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    })
    const waiting = f.agent(call)
    await vi.waitFor(() => expect(f.config.slots.running).toBe(0))
    f.controller.abort(new Error('Workflow stopped'))
    await expect(waiting).rejects.toThrow('Workflow stopped')
    expect(order).toEqual([])
    expect(f.config.slots.queued).toBe(0)
  })

  it('replays an accepted result without asking the account again', async () => {
    let asked = 0
    const order: string[] = []
    const { launch } = accountLaunch(order)
    launch.account = async (_call, work) => {
      asked++
      return { done: await work() }
    }
    const f = setup(launch)
    expect(await f.agent(call)).toEqual({ answer: 'correct' })
    expect(await createDurableWorkflowAgent(f.config)(call)).toEqual({ answer: 'correct' })
    expect({ asked, launches: order.length }).toEqual({ asked: 1, launches: 1 })
  })
})
