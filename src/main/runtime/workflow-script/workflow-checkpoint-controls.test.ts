import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import { WorkflowCheckpointStore } from './workflow-checkpoint-store'

const databases: OrchestrationDb[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})
function setup() {
  const database = new OrchestrationDb(':memory:')
  databases.push(database)
  const store = new WorkflowCheckpointStore(database.db)
  const executionId = store.create({
    conversationId: 'c',
    requestId: 'r',
    snapshot: {},
    preset: 'council',
    fence: 1,
    attemptLimit: 3,
    callLimit: 7,
    budgetLimit: 30
  })
  const input = {
    executionId,
    fence: 1,
    callId: 'answers/a',
    inputDigest: 'input',
    reservation: 10,
    validate: () => {}
  }
  const prepare = (callId = input.callId) => {
    const attempt = store.prepare({ ...input, callId })
    if (!('attemptId' in attempt)) {
      throw new Error('expected attempt')
    }
    return attempt
  }
  const launch = (callId = input.callId) => {
    const attempt = prepare(callId)
    store.recordLaunch(attempt.attemptId, 1, attempt.attemptId)
    return {
      ...attempt,
      receipt: {
        attemptId: attempt.attemptId,
        processReceiptRef: attempt.attemptId,
        liveness: 'exited' as const
      }
    }
  }
  const state = () =>
    (
      database.db
        .prepare('SELECT state FROM local_workflow_executions WHERE id=?')
        .get(executionId) as { state: string }
    ).state
  return { database, store, executionId, input, prepare, launch, state }
}

describe('durable workflow controls', () => {
  it('drains a paused call into cached evidence and resumes without a new attempt', () => {
    const f = setup()
    const attempt = f.launch()
    expect(f.store.requestControl(f.executionId, 1, 'pause')).toBe('pausing')
    expect(() => f.store.prepare({ ...f.input, callId: 'answers/b' })).toThrow('admission')
    expect(() => f.store.resume(f.executionId, 1)).toThrow('drained')
    expect(f.store.accept(attempt.attemptId, 1, 'answer', attempt.receipt, f.input.validate)).toBe(
      true
    )
    expect(f.state()).toBe('paused')
    f.store.resume(f.executionId, 1)
    expect(f.state()).toBe('running')
    expect(f.store.prepare(f.input)).toEqual({ cached: 'answer' })
  })

  it('stop dominates pause and waits for every launched sibling', () => {
    const f = setup()
    const a = f.launch()
    const b = f.launch('answers/b')
    expect(f.store.requestControl(f.executionId, 1, 'pause')).toBe('pausing')
    expect(f.store.requestControl(f.executionId, 1, 'stop')).toBe('stopping')
    expect(f.store.requestControl(f.executionId, 1, 'pause')).toBe('stopping')
    expect(f.store.accept(a.attemptId, 1, 'late', a.receipt, f.input.validate)).toBe(false)
    expect(f.store.settleFailure(a.attemptId, 1, a.receipt, 'cancelled')).toBe(true)
    expect(f.state()).toBe('stopping')
    expect(f.store.settleFailure(b.attemptId, 1, b.receipt, 'cancelled')).toBe(true)
    expect(f.state()).toBe('cancelled')
    expect(() => f.store.resume(f.executionId, 1)).toThrow('drained')
  })

  it('does not declare prepared attempts dead or reopen admission', () => {
    const f = setup()
    f.prepare()
    expect(f.store.requestControl(f.executionId, 1, 'stop')).toBe('stopping')
    expect(() => f.store.resume(f.executionId, 1)).toThrow('drained')
    expect(() => f.store.prepare(f.input)).toThrow('admission')
  })

  it('requires matching exit evidence and fences before failed calls can retry', () => {
    const f = setup()
    const a = f.launch()
    expect(() => f.store.settleFailure(a.attemptId, 2, a.receipt, 'failed')).toThrow('fence')
    expect(() =>
      f.store.settleFailure(a.attemptId, 1, { ...a.receipt, processReceiptRef: 'wrong' }, 'failed')
    ).toThrow('receipt')
    expect(() => f.store.prepare(f.input)).toThrow('reconciliation')
    expect(f.store.settleFailure(a.attemptId, 1, a.receipt, 'invalid JSON')).toBe(true)
    expect(f.store.settleFailure(a.attemptId, 1, a.receipt, 'duplicate')).toBe(false)
    expect(f.prepare().ordinal).toBe(2)
    expect(
      f.database.db.prepare('SELECT budget_reserved FROM local_workflow_executions').get()
    ).toMatchObject({ budget_reserved: 20 })
  })

  it('persists the retry ceiling across confirmed failures', () => {
    const f = setup()
    for (let ordinal = 1; ordinal <= 3; ordinal++) {
      const a = f.launch()
      expect(a.ordinal).toBe(ordinal)
      f.store.settleFailure(a.attemptId, 1, a.receipt, 'invalid schema')
    }
    expect(() => f.prepare()).toThrow('attempt budget exhausted')
  })

  it('refuses to retry an older failure while a newer workflow owns the conversation', () => {
    const f = setup()
    const attempt = f.launch()
    f.store.settleFailure(attempt.attemptId, 1, attempt.receipt, 'invalid output')
    expect(f.store.finish(f.executionId, 1, false)).toBe('failed')
    const newer = f.store.create({
      conversationId: 'c',
      requestId: 'newer',
      snapshot: {},
      preset: 'council',
      fence: 1,
      attemptLimit: 3,
      callLimit: 7,
      budgetLimit: 30
    })
    expect(() => f.store.retryFailed(f.executionId, 1)).toThrow('Another workflow')
    expect(f.store.finish(newer, 1, false)).toBe('failed')
    f.store.retryFailed(f.executionId, 1)
    expect(f.store.inspect(f.executionId, 1).state).toBe('paused')
  })

  it('pauses and stops empty executions immediately', () => {
    const f = setup()
    expect(f.store.requestControl(f.executionId, 1, 'pause')).toBe('paused')
    expect(f.store.requestControl(f.executionId, 1, 'pause')).toBe('paused')
    expect(f.store.requestControl(f.executionId, 1, 'stop')).toBe('cancelled')
  })
})
