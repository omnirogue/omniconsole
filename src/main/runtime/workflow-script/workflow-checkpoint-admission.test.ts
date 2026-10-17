import { describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import {
  workflowCallCeiling,
  workflowSettlesExhaustedCalls,
  workflowSettlesSupersededCalls
} from './workflow-checkpoint-admission'
import { hasWorkflowRetryableCalls } from './workflow-retry-eligibility'

describe('workflow call ceilings', () => {
  it('keeps legacy and working ceilings and raises them only for Council 6 and Discover 7', () => {
    expect(workflowCallCeiling('council', { councilProgramRevision: 4 })).toBe(7)
    expect(workflowCallCeiling('council', {})).toBe(7)
    // The working-agent programs keep the ceilings they were admitted under.
    expect(workflowCallCeiling('council', { councilProgramRevision: 5 })).toBe(7)
    expect(workflowCallCeiling('council', { councilProgramRevision: 6 })).toBe(13)
    expect(workflowCallCeiling('discover', {})).toBe(28)
    expect(workflowCallCeiling('discover', { discoverProgramRevision: 3 })).toBe(28)
    expect(workflowCallCeiling('discover', { discoverProgramRevision: 4 })).toBe(30)
    expect(workflowCallCeiling('discover', { discoverProgramRevision: 5 })).toBe(30)
    expect(workflowCallCeiling('discover', { discoverProgramRevision: 6 })).toBe(30)
    expect(workflowCallCeiling('discover', { discoverProgramRevision: 7 })).toBe(400)
    expect(workflowCallCeiling('discover', null)).toBe(28)
  })

  it('admits a 400-call Discover revision 7 run and refuses one call more', () => {
    const database = new OrchestrationDb(':memory:')
    try {
      const store = new WorkflowCheckpointStore(database.db)
      const request = {
        conversationId: 'discover-seven',
        requestId: 'first',
        snapshot: { discoverProgramRevision: 7 },
        preset: 'discover' as const,
        fence: 1,
        attemptLimit: 3,
        callLimit: 400,
        budgetLimit: 1200
      }
      const id = store.create(request)
      expect(
        database.db
          .prepare('SELECT call_limit, budget_limit FROM local_workflow_executions WHERE id=?')
          .get(id)
      ).toMatchObject({ call_limit: 400, budget_limit: 1200 })
      expect(() =>
        store.create({
          ...request,
          conversationId: 'discover-too-many',
          callLimit: 401,
          budgetLimit: 1203
        })
      ).toThrow('Preset call ceiling exceeded')
      expect(() =>
        store.create({
          ...request,
          conversationId: 'discover-five',
          snapshot: { discoverProgramRevision: 5 },
          callLimit: 31
        })
      ).toThrow('Preset call ceiling exceeded')
      expect(() =>
        store.create({
          ...request,
          conversationId: 'discover-working',
          snapshot: { discoverProgramRevision: 6 },
          callLimit: 31
        })
      ).toThrow('Preset call ceiling exceeded')
    } finally {
      database.close()
    }
  })

  it('admits a six-member Council revision 6 run but keeps legacy and working Council at seven', () => {
    const database = new OrchestrationDb(':memory:')
    try {
      const store = new WorkflowCheckpointStore(database.db)
      const request = {
        conversationId: 'council-six',
        requestId: 'first',
        snapshot: { councilProgramRevision: 6 },
        preset: 'council' as const,
        fence: 1,
        attemptLimit: 3,
        callLimit: 13,
        budgetLimit: 39
      }
      expect(store.create(request)).toEqual(expect.any(String))
      expect(() =>
        store.create({ ...request, conversationId: 'council-too-many', callLimit: 14 })
      ).toThrow('Preset call ceiling exceeded')
      expect(() =>
        store.create({
          ...request,
          conversationId: 'council-four',
          snapshot: { councilProgramRevision: 4 },
          callLimit: 8
        })
      ).toThrow('Preset call ceiling exceeded')
      expect(() =>
        store.create({
          ...request,
          conversationId: 'council-working',
          snapshot: { councilProgramRevision: 5 },
          callLimit: 8
        })
      ).toThrow('Preset call ceiling exceeded')
    } finally {
      database.close()
    }
  })
})

function started(snapshot: unknown, preset: 'council' | 'discover' = 'discover') {
  const database = new OrchestrationDb(':memory:')
  const store = new WorkflowCheckpointStore(database.db)
  const id = store.create({
    conversationId: 'conversation',
    requestId: 'request',
    snapshot,
    preset,
    fence: 1,
    attemptLimit: 3,
    callLimit: preset === 'council' ? 7 : 20,
    budgetLimit: 60
  })
  const attempt = (callId: string, ordinal: number, state: string) =>
    database.db
      .prepare(
        `INSERT INTO local_workflow_attempts (id,execution_id,call_id,ordinal,fence,state,reservation,receipt_json) VALUES (?,?,?,?,1,?,1,'{}')`
      )
      .run(`${callId}-${ordinal}`, id, callId, ordinal, state)
  const failed = (callId: string, attempts: number, quarantined = 0) => {
    database.db
      .prepare(
        'INSERT INTO local_workflow_calls (execution_id,call_id,input_digest,quarantined) VALUES (?,?,?,?)'
      )
      .run(id, callId, `${callId}-input`, quarantined)
    for (let ordinal = 1; ordinal <= attempts; ordinal++) {
      attempt(callId, ordinal, 'failed')
    }
  }
  const accepted = (callId: string) => {
    database.db
      .prepare(
        'INSERT INTO local_workflow_calls (execution_id,call_id,input_digest,accepted_attempt_id) VALUES (?,?,?,?)'
      )
      .run(id, callId, `${callId}-input`, `${callId}-1`)
    attempt(callId, 1, 'accepted')
  }
  const prepare = (callId: string) =>
    store.prepare({
      executionId: id,
      fence: 1,
      callId,
      inputDigest: `${callId}-input`,
      reservation: 1,
      validate: () => {}
    })
  const retryable = () => hasWorkflowRetryableCalls(database.db, id, 3)
  return { database, store, id, attempt, failed, accepted, prepare, retryable }
}

describe('calls whose persisted attempts ran out', () => {
  it('recognises Discover revision 7 and Council revision 6 as programs that settle them', () => {
    const envelope = (preset: string, snapshot: unknown) => JSON.stringify({ preset, snapshot })
    expect(
      workflowSettlesExhaustedCalls(envelope('discover', { discoverProgramRevision: 7 }))
    ).toBe(true)
    expect(
      workflowSettlesExhaustedCalls(envelope('discover', { discoverProgramRevision: 6 }))
    ).toBe(false)
    expect(
      workflowSettlesExhaustedCalls(envelope('discover', { discoverProgramRevision: 5 }))
    ).toBe(false)
    expect(workflowSettlesExhaustedCalls(envelope('discover', {}))).toBe(false)
    expect(workflowSettlesExhaustedCalls(envelope('council', { councilProgramRevision: 6 }))).toBe(
      true
    )
    // The working-agent Council keeps the original rules; so does a revision under another preset.
    for (const councilProgramRevision of [4, 5]) {
      expect(workflowSettlesExhaustedCalls(envelope('council', { councilProgramRevision }))).toBe(
        false
      )
    }
    expect(workflowSettlesExhaustedCalls(envelope('discover', { councilProgramRevision: 6 }))).toBe(
      false
    )
    expect(workflowSettlesExhaustedCalls('not json')).toBe(false)
    // Only Council 6 also settles calls a later stage was keyed without.
    expect(workflowSettlesSupersededCalls(envelope('council', { councilProgramRevision: 6 }))).toBe(
      true
    )
    for (const snapshot of [{ councilProgramRevision: 5 }, { councilProgramRevision: 4 }, {}]) {
      expect(workflowSettlesSupersededCalls(envelope('council', snapshot))).toBe(false)
    }
    expect(
      workflowSettlesSupersededCalls(envelope('discover', { discoverProgramRevision: 7 }))
    ).toBe(false)
    expect(workflowSettlesSupersededCalls('not json')).toBe(false)
  })

  it('lets Discover revision 7 complete around a finder that spent every attempt', () => {
    const run = started({ discoverProgramRevision: 7 })
    try {
      run.failed('find/r1/0/correctness', 3)
      expect(run.store.finish(run.id, 1, true)).toBe('completed')
    } finally {
      run.database.close()
    }
  })

  it('still refuses to complete Discover revision 7 while a failed call has attempts left', () => {
    const run = started({ discoverProgramRevision: 7 })
    try {
      run.failed('find/r1/0/correctness', 3)
      run.failed('rank/final', 1)
      expect(() => run.store.finish(run.id, 1, true)).toThrow('Workflow has unresolved results')
      expect(run.retryable()).toBe(true)
    } finally {
      run.database.close()
    }
  })

  it('retries Discover revision 7 only while some call has room and none is quarantined', () => {
    const exhausted = started({ discoverProgramRevision: 7 })
    const quarantined = started({ discoverProgramRevision: 7 })
    try {
      exhausted.failed('find/r1/0/correctness', 3)
      expect(exhausted.retryable()).toBe(false)
      quarantined.failed('find/r1/0/correctness', 3)
      quarantined.failed('rank/final', 1, 1)
      expect(quarantined.retryable()).toBe(false)
    } finally {
      exhausted.database.close()
      quarantined.database.close()
    }
  })

  it('keeps the all-calls rule for legacy Discover revisions', () => {
    const run = started({ discoverProgramRevision: 5 })
    try {
      run.failed('discover/correctness', 3)
      expect(() => run.store.finish(run.id, 1, true)).toThrow('Workflow has unresolved results')
      run.failed('rank/final', 1)
      expect(run.retryable()).toBe(false)
    } finally {
      run.database.close()
    }
  })
})

describe('Council revision 6 answers and rankings a later stage was keyed without', () => {
  const council = (revision = 6) => started({ councilProgramRevision: revision }, 'council')

  it('completes around a failed member and ranking that still have attempts left', () => {
    const run = council()
    try {
      run.accepted('answer/seat-1')
      run.failed('answer/seat-4', 2)
      run.accepted('rank/seat-1')
      run.failed('rank/seat-2', 2)
      run.accepted('chair/final')
      expect(run.store.finish(run.id, 1, true)).toBe('completed')
    } finally {
      run.database.close()
    }
  })

  it('keeps a failed chairman failed and retryable until its own attempts are spent', () => {
    const run = council()
    try {
      run.failed('answer/seat-4', 2)
      run.accepted('rank/seat-1')
      run.failed('rank/seat-2', 1)
      run.failed('chair/final', 2)
      expect(() => run.store.finish(run.id, 1, true)).toThrow('Workflow has unresolved results')
      expect(run.retryable()).toBe(true)
      // The member and ranking still have room, but only the chairman may run again.
      run.attempt('chair/final', 3, 'failed')
      expect(run.retryable()).toBe(false)
    } finally {
      run.database.close()
    }
  })

  it('retries members that answered nothing while no later stage was keyed on them', () => {
    const run = council()
    try {
      run.failed('answer/seat-1', 2)
      run.failed('answer/seat-2', 3)
      expect(run.retryable()).toBe(true)
      run.attempt('answer/seat-1', 3, 'failed')
      expect(run.retryable()).toBe(false)
    } finally {
      run.database.close()
    }
  })

  it('replays a superseded call as the same null instead of launching it again', () => {
    const early = council()
    const ranking = council()
    const chairing = council()
    try {
      // Nothing was keyed on the answers yet (a Resume during first opinions): it may run again.
      early.failed('answer/seat-4', 1)
      expect(early.prepare('answer/seat-4')).toMatchObject({ ordinal: 2 })
      ranking.failed('answer/seat-4', 2)
      ranking.failed('rank/seat-1', 1)
      for (const callId of ['answer/seat-4', 'answer/seat-5']) {
        expect(() => ranking.prepare(callId)).toThrow(
          'A later council stage was recorded without this result'
        )
      }
      expect(ranking.prepare('rank/seat-1')).toMatchObject({ ordinal: 2 })
      chairing.failed('rank/seat-2', 1)
      chairing.failed('chair/final', 1)
      expect(() => chairing.prepare('rank/seat-2')).toThrow('A later council stage')
      expect(chairing.prepare('chair/final')).toMatchObject({ ordinal: 2 })
      expect(
        chairing.database.db
          .prepare('SELECT COUNT(*) AS count FROM local_workflow_attempts WHERE call_id=?')
          .get('rank/seat-2')
      ).toEqual({ count: 1 })
    } finally {
      early.database.close()
      ranking.database.close()
      chairing.database.close()
    }
  })

  it('reuses the cached admission, Retry and finish statements instead of recompiling them', () => {
    const run = council()
    try {
      run.failed('answer/seat-4', 1)
      run.failed('rank/seat-1', 1)
      const original = run.database.db.prepare.bind(run.database.db)
      const prepared = new Map<string, unknown[]>()
      vi.spyOn(run.database.db, 'prepare').mockImplementation((sql) => {
        const statement = original(sql)
        if (sql.includes('later.call_id')) {
          prepared.set(sql, [...(prepared.get(sql) ?? []), statement])
        }
        return statement
      })
      for (let round = 0; round < 2; round++) {
        expect(() => run.prepare('answer/seat-4')).toThrow('A later council stage')
        expect(run.retryable()).toBe(true)
        expect(() => run.store.finish(run.id, 1, true)).toThrow('Workflow has unresolved results')
      }
      // The statement cache skips SQL containing `*`, so the stage test must not use GLOB.
      expect(prepared.size).toBe(3)
      for (const statements of prepared.values()) {
        expect(statements).toHaveLength(2)
        expect(statements[0]).toBe(statements[1])
      }
    } finally {
      run.database.close()
    }
  })

  it('keeps the all-calls rule and launches for the working-agent Council', () => {
    const run = council(5)
    try {
      run.failed('answer/seat-4', 2)
      run.failed('rank/seat-1', 1)
      run.accepted('chair/final')
      expect(() => run.store.finish(run.id, 1, true)).toThrow('Workflow has unresolved results')
      expect(run.retryable()).toBe(true)
      expect(run.prepare('answer/seat-4')).toMatchObject({ ordinal: 3 })
    } finally {
      run.database.close()
    }
  })
})
