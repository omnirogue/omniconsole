import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import type { WorkflowProcessReceiptIdentity } from './workflow-process-receipt-identity'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-prepared-process-'))
  directories.push(directory)
  const database = new OrchestrationDb(join(directory, 'workflow.db'))
  const store = new WorkflowCheckpointStore(database.db)
  const executionId = store.create({
    conversationId: 'conversation',
    requestId: 'first',
    snapshot: {},
    preset: 'council',
    fence: 1,
    attemptLimit: 3,
    callLimit: 7,
    budgetLimit: 3
  })
  const attempt = store.prepare({
    executionId,
    fence: 1,
    callId: 'answers/a',
    inputDigest: 'frozen',
    reservation: 1,
    validate: () => {}
  })
  if (!('attemptId' in attempt)) {
    throw new Error('Expected prepared attempt')
  }
  const identity: WorkflowProcessReceiptIdentity = {
    ...attempt,
    directory,
    executionId,
    fence: 1,
    callId: 'answers/a',
    hostId: 'host',
    ownerIncarnation: 'owner',
    commandDigest: 'a'.repeat(64),
    inputDigest: 'b'.repeat(64),
    maxOutputBytes: 1024
  }
  return { database, store, identity, path: join(directory, attempt.attemptId, 'launch.json') }
}

describe.skipIf(process.platform === 'win32')('prepared process authority', () => {
  it('settles only an untouched prepared attempt as proven not launched', () => {
    const f = setup()
    try {
      f.store.recordNoLaunch(f.identity.attemptId, 1, 'Input materialization failed')
      expect(
        f.database.db
          .prepare('SELECT state,receipt_json FROM local_workflow_attempts WHERE id=?')
          .get(f.identity.attemptId)
      ).toMatchObject({ state: 'failed', receipt_json: expect.stringContaining('"noLaunch":true') })
      expect(() => f.store.recordNoLaunch(f.identity.attemptId, 1, 'again')).toThrow(
        'untouched prepared'
      )
      expect(() => f.store.recordProcessPreparation(f.identity.attemptId, 1, f.identity)).toThrow(
        'state rejected'
      )
    } finally {
      f.database.close()
    }
  })
  it.each(['accepted', 'failed'] as const)(
    'retains independent identity after %s settlement and reopening the database',
    (outcome) => {
      const f = setup()
      try {
        f.store.recordProcessPreparation(f.identity.attemptId, 1, f.identity)
        expect(() => f.store.recordProcessPreparation(f.identity.attemptId, 1, f.identity)).toThrow(
          'state rejected'
        )
        f.store.recordLaunch(f.identity.attemptId, 1, f.path)
        const receipt = {
          attemptId: f.identity.attemptId,
          processReceiptRef: f.path,
          liveness: 'exited' as const
        }
        if (outcome === 'accepted') {
          f.store.accept(f.identity.attemptId, 1, {}, receipt, () => {})
        } else {
          f.store.settleFailure(f.identity.attemptId, 1, receipt, 'invalid output')
        }
        expect(f.store.readProcessIdentity(f.identity.attemptId, 1)).toEqual(f.identity)
      } finally {
        f.database.close()
      }
      const reopened = new OrchestrationDb(join(f.identity.directory, 'workflow.db'))
      try {
        expect(
          new WorkflowCheckpointStore(reopened.db).readProcessIdentity(f.identity.attemptId, 1)
        ).toEqual(f.identity)
      } finally {
        reopened.close()
      }
    }
  )
  it('rejects missing, changed, or corrupted prepared evidence without resetting the attempt', () => {
    const f = setup()
    try {
      expect(() => f.store.readProcessIdentity(f.identity.attemptId, 1)).toThrow(
        'missing or corrupt'
      )
      expect(() =>
        f.store.recordProcessPreparation(f.identity.attemptId, 1, {
          ...f.identity,
          callId: 'other'
        })
      ).toThrow('identity mismatch')
      f.store.recordProcessPreparation(f.identity.attemptId, 1, f.identity)
      expect(() => f.store.recordLaunch(f.identity.attemptId, 1, 'other')).toThrow('path mismatch')
      expect(() => f.store.readProcessIdentity(f.identity.attemptId, 2)).toThrow('fence')
      f.database.db
        .prepare(
          `UPDATE local_workflow_attempts SET receipt_json='{"preparedProcess":{"json":"{}","digest":"wrong"}}'`
        )
        .run()
      expect(() => f.store.readProcessIdentity(f.identity.attemptId, 1)).toThrow(
        'missing or corrupt'
      )
      expect(f.database.db.prepare('SELECT state FROM local_workflow_attempts').get()).toEqual({
        state: 'prepared'
      })
    } finally {
      f.database.close()
    }
  })
  it('bumps the execution sequence when a prepared attempt starts running', () => {
    const f = setup()
    try {
      const sequence = () =>
        (
          f.database.db
            .prepare('SELECT sequence FROM local_workflow_executions WHERE id=?')
            .get(f.identity.executionId) as { sequence: number }
        ).sequence
      f.store.recordProcessPreparation(f.identity.attemptId, 1, f.identity)
      const before = sequence()
      f.store.recordLaunch(f.identity.attemptId, 1, f.path)
      expect(sequence()).toBe(before + 1)
      expect(f.database.db.prepare('SELECT state FROM local_workflow_attempts').get()).toEqual({
        state: 'running'
      })
    } finally {
      f.database.close()
    }
  })
  it('does not authorize preparing a process after stop', () => {
    const f = setup()
    try {
      f.store.requestControl(f.identity.executionId, 1, 'stop')
      expect(() => f.store.recordProcessPreparation(f.identity.attemptId, 1, f.identity)).toThrow(
        'state rejected'
      )
      expect(
        f.database.db.prepare('SELECT receipt_json FROM local_workflow_attempts').get()
      ).toEqual({ receipt_json: null })
    } finally {
      f.database.close()
    }
  })
})
