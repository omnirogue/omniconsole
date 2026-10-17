import { describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import { captureWorkflowOwner, claimWorkflowOwner } from './workflow-owner-claim'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'

async function setup(withOwner = true) {
  const database = new OrchestrationDb(':memory:')
  const db = database.db
  const store = new WorkflowCheckpointStore(db)
  const previous = {
    hostId: 'host',
    pid: 987654,
    processStartTimeMs: 1000,
    spawnToken: 'old-owner'
  }
  const owner = await captureWorkflowOwner('host')
  const executionId = store.create({
    conversationId: 'c',
    requestId: 'r',
    snapshot: {},
    preset: 'council',
    fence: 1,
    attemptLimit: 3,
    callLimit: 7,
    budgetLimit: 3,
    ...(withOwner ? { owner: previous } : {})
  })
  const transaction = <T>(work: () => T): T => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  const claim = (outcome: AgentSessionOwnerProbe = { outcome: 'pid-absent' }) =>
    claimWorkflowOwner({
      db,
      transaction,
      executionId,
      expectedFence: 1,
      owner,
      probe: async () => outcome
    })
  return { database, db, store, owner, previous, executionId, transaction, claim }
}

describe('workflow host ownership', () => {
  it.each([
    { outcome: 'identity-matched', matchedOn: ['process-start-time'] },
    { outcome: 'indeterminate', reason: 'process table unavailable' },
    { outcome: 'reservation-unused' }
  ] as AgentSessionOwnerProbe[])('refuses takeover for $outcome', async (probe) => {
    const f = await setup()
    try {
      await expect(f.claim(probe)).rejects.toThrow('live or unverifiable')
      expect(f.store.inspect(f.executionId, 1).state).toBe('running')
    } finally {
      f.database.close()
    }
  })
  it('advances the fence only after proven exit, closing admission and fencing old writers', async () => {
    const f = await setup()
    try {
      expect(await f.claim()).toBe(2)
      expect(f.store.inspect(f.executionId, 2).state).toBe('paused')
      expect(() => f.store.requestControl(f.executionId, 1, 'stop')).toThrow('fence')
      expect(() =>
        f.store.prepare({
          executionId: f.executionId,
          fence: 2,
          callId: 'a',
          inputDigest: 'x',
          reservation: 1,
          validate: () => {}
        })
      ).toThrow('admission is stopped')
      const probe = vi.fn()
      expect(
        await claimWorkflowOwner({
          db: f.db,
          transaction: f.transaction,
          executionId: f.executionId,
          expectedFence: 2,
          owner: f.owner,
          probe
        })
      ).toBe(2)
      expect(probe).not.toHaveBeenCalled()
    } finally {
      f.database.close()
    }
  })
  it('refuses another host and missing legacy owner evidence', async () => {
    const f = await setup(false)
    try {
      await expect(f.claim()).rejects.toThrow('missing or corrupt')
    } finally {
      f.database.close()
    }
    const g = await setup()
    try {
      await expect(
        claimWorkflowOwner({
          db: g.db,
          transaction: g.transaction,
          executionId: g.executionId,
          expectedFence: 1,
          owner: { ...g.owner, hostId: 'other' }
        })
      ).rejects.toThrow('another or unknown host')
    } finally {
      g.database.close()
    }
  })
  it('rechecks the owner and fence after a concurrent claimant wins', async () => {
    const f = await setup()
    try {
      let release!: (value: AgentSessionOwnerProbe) => void
      const waiting = claimWorkflowOwner({
        db: f.db,
        transaction: f.transaction,
        executionId: f.executionId,
        expectedFence: 1,
        owner: f.owner,
        probe: () =>
          new Promise((resolve) => {
            release = resolve
          })
      })
      await vi.waitFor(() => expect(release).toBeDefined())
      expect(await f.claim()).toBe(2)
      release({ outcome: 'pid-absent' })
      await expect(waiting).rejects.toThrow('changed while probing')
      expect(f.store.inspect(f.executionId, 2).state).toBe('paused')
    } finally {
      f.database.close()
    }
  })
  it('keeps durable stop intent on transfer', async () => {
    const f = await setup()
    try {
      f.store.prepare({
        executionId: f.executionId,
        fence: 1,
        callId: 'a',
        inputDigest: 'x',
        reservation: 1,
        validate: () => {}
      })
      f.store.requestControl(f.executionId, 1, 'stop')
      expect(await f.claim()).toBe(2)
      expect(f.store.inspect(f.executionId, 2).state).toBe('stopping')
    } finally {
      f.database.close()
    }
  })
})

it('refuses fabricated identity for the current PID before probing previous owner', async () => {
  const f = await setup()
  try {
    const probe = vi.fn()
    await expect(
      claimWorkflowOwner({
        db: f.db,
        transaction: f.transaction,
        executionId: f.executionId,
        expectedFence: 1,
        owner: { ...f.owner, spawnToken: 'forged' },
        probe
      })
    ).rejects.toThrow('this owner incarnation')
    expect(probe).not.toHaveBeenCalled()
    expect(f.store.inspect(f.executionId, 1).state).toBe('running')
  } finally {
    f.database.close()
  }
})
