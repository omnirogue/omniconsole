import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import { WorkflowCheckpointStore } from './workflow-checkpoint-store'

function setup() {
  const database = new OrchestrationDb(':memory:')
  const store = new WorkflowCheckpointStore(database.db)
  const request = {
    conversationId: 'conversation',
    requestId: 'start-1',
    snapshot: { prompt: 'frozen' },
    preset: 'council' as const,
    fence: 1,
    attemptLimit: 3,
    callLimit: 7,
    budgetLimit: 10
  }
  const executionId = store.create(request)
  const input = {
    executionId,
    fence: 1,
    callId: 'answers/a',
    inputDigest: 'input-digest',
    reservation: 10,
    validate: (value: unknown) => {
      if (value !== 'accepted') {
        throw new Error('invalid result')
      }
    }
  }
  return { database, store, request, input }
}

describe('durable workflow checkpoint boundaries', () => {
  it('reserves thirty calls for pinned Discover revisions four and five', () => {
    const database = new OrchestrationDb(':memory:')
    const store = new WorkflowCheckpointStore(database.db)
    try {
      const request = {
        conversationId: 'discover-ceiling',
        requestId: 'first',
        snapshot: { discoverProgramRevision: 2 },
        preset: 'discover' as const,
        fence: 1,
        attemptLimit: 3,
        callLimit: 30,
        budgetLimit: 90
      }
      for (const revision of [undefined, 1, 2, 3]) {
        expect(() =>
          store.create({ ...request, snapshot: { discoverProgramRevision: revision } })
        ).toThrow('Preset call ceiling exceeded')
      }
      const id = store.create({ ...request, snapshot: { discoverProgramRevision: 4 } })
      expect(
        database.db.prepare('SELECT call_limit FROM local_workflow_executions WHERE id=?').get(id)
      ).toMatchObject({ call_limit: 30 })
      const next = store.create({
        ...request,
        requestId: 'second',
        conversationId: 'discover-five',
        snapshot: { discoverProgramRevision: 5 }
      })
      expect(
        database.db.prepare('SELECT call_limit FROM local_workflow_executions WHERE id=?').get(next)
      ).toMatchObject({ call_limit: 30 })
    } finally {
      database.close()
    }
  })
  it('deduplicates starts but rejects changed requests', () => {
    const fixture = setup()
    try {
      expect(fixture.store.create(fixture.request)).toBe(fixture.input.executionId)
      expect(() => fixture.store.create({ ...fixture.request, fence: 2 })).toThrow(
        'fenced recovery'
      )
      expect(() => fixture.store.create({ ...fixture.request, budgetLimit: 9 })).toThrow(
        'Conflicting'
      )
    } finally {
      fixture.database.close()
    }
  })
  it('prepares once, rejects ambiguous relaunch and cached work replays at zero allowance', () => {
    const { database, store, input } = setup()
    try {
      const attempt = store.prepare(input)
      if (!('attemptId' in attempt)) {
        throw new Error('expected launch')
      }
      expect(() => store.prepare(input)).toThrow('reconciliation')
      store.recordLaunch(attempt.attemptId, 1, 'receipt-ref')
      const receipt = {
        attemptId: attempt.attemptId,
        processReceiptRef: 'receipt-ref',
        liveness: 'exited' as const
      }
      expect(store.accept(attempt.attemptId, 1, 'accepted', receipt, input.validate)).toBe(true)
      expect(store.accept(attempt.attemptId, 1, 'accepted', receipt, input.validate)).toBe(false)
      expect(store.prepare(input)).toEqual({ cached: 'accepted' })
      expect(() => store.prepare({ ...input, callId: 'answers/b' })).toThrow('allowance exhausted')
    } finally {
      database.close()
    }
  })
  it('quarantines corrupted committed evidence without buying another attempt', () => {
    const { database, store, input } = setup()
    try {
      const attempt = store.prepare(input)
      if (!('attemptId' in attempt)) {
        throw new Error('expected launch')
      }
      store.recordLaunch(attempt.attemptId, 1, 'receipt')
      store.accept(
        attempt.attemptId,
        1,
        'accepted',
        { attemptId: attempt.attemptId, processReceiptRef: 'receipt', liveness: 'exited' },
        input.validate
      )
      database.db.prepare("UPDATE local_workflow_calls SET result_json='corrupt'").run()
      expect(() => store.prepare(input)).toThrow('digest mismatch')
      expect(() => store.prepare(input)).toThrow('recovery is blocked')
      expect(
        database.db.prepare('SELECT COUNT(*) AS count FROM local_workflow_attempts').get()
      ).toMatchObject({ count: 1 })
    } finally {
      database.close()
    }
  })
  it('requires matching ownership and terminal process receipts', () => {
    const { database, store, input } = setup()
    try {
      expect(() => store.prepare({ ...input, fence: 2 })).toThrow('fence')
      const attempt = store.prepare(input)
      if (!('attemptId' in attempt)) {
        throw new Error('expected launch')
      }
      store.recordLaunch(attempt.attemptId, 1, 'receipt')
      expect(() =>
        store.accept(
          attempt.attemptId,
          1,
          'accepted',
          { attemptId: attempt.attemptId, processReceiptRef: 'other', liveness: 'exited' },
          input.validate
        )
      ).toThrow('mismatch')
      expect(
        database.db.prepare('SELECT result_json FROM local_workflow_calls').get()
      ).toMatchObject({ result_json: null })
    } finally {
      database.close()
    }
  })
})

it('refuses launch after durable stop intent', () => {
  const { database, store, input } = setup()
  try {
    const attempt = store.prepare(input)
    if (!('attemptId' in attempt)) {
      throw new Error('expected launch')
    }
    database.db
      .prepare("UPDATE local_workflow_executions SET state='stopping' WHERE id=?")
      .run(input.executionId)
    expect(() => store.recordLaunch(attempt.attemptId, 1, 'receipt')).toThrow(
      'admission is stopped'
    )
    expect(database.db.prepare('SELECT state FROM local_workflow_attempts').get()).toMatchObject({
      state: 'prepared'
    })
  } finally {
    database.close()
  }
})

it.each(['missing', 'already-committed', 'quarantined'])(
  'does not accept an attempt when its call is %s',
  (fault) => {
    const { database, store, input } = setup()
    try {
      const attempt = store.prepare(input)
      if (!('attemptId' in attempt)) {
        throw new Error('expected launch')
      }
      store.recordLaunch(attempt.attemptId, 1, 'receipt')
      if (fault === 'missing') {
        database.db.prepare('DELETE FROM local_workflow_calls').run()
      } else if (fault === 'already-committed') {
        database.db
          .prepare(
            "UPDATE local_workflow_calls SET accepted_attempt_id='other',result_json='original',result_digest='original-digest'"
          )
          .run()
      } else {
        database.db.prepare('UPDATE local_workflow_calls SET quarantined=1').run()
      }
      const before = database.db.prepare('SELECT * FROM local_workflow_calls').all()
      expect(() =>
        store.accept(
          attempt.attemptId,
          1,
          'accepted',
          {
            attemptId: attempt.attemptId,
            processReceiptRef: 'receipt',
            liveness: 'exited'
          },
          input.validate
        )
      ).toThrow('result commit rejected')
      expect(database.db.prepare('SELECT state FROM local_workflow_attempts').get()).toMatchObject({
        state: 'running'
      })
      expect(database.db.prepare('SELECT * FROM local_workflow_calls').all()).toEqual(before)
    } finally {
      database.close()
    }
  }
)

it('cache-only replay never prepares a missing call even while execution is running', () => {
  const { database, store, input } = setup()
  try {
    expect(() => store.prepare({ ...input, cacheOnly: true })).toThrow('not committed')
    expect(
      database.db.prepare('SELECT COUNT(*) AS count FROM local_workflow_attempts').get()
    ).toEqual({ count: 0 })
    expect(
      database.db.prepare('SELECT budget_reserved FROM local_workflow_executions').get()
    ).toEqual({ budget_reserved: 0 })
  } finally {
    database.close()
  }
})
