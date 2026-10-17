import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import { createWorkflowLocalProcessLaunch } from './workflow-local-process-launch'
import { claimWorkflowOwner, captureWorkflowOwner } from './workflow-owner-claim'
import { workflowCallDigest } from './workflow-call-digest'
import type { WorkflowProgramCall } from './workflow-program-context'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})
async function fixture(valid = true, openrouter = false, spare = false) {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-recover-'))
  directories.push(directory)
  const database = new OrchestrationDb(join(directory, 'workflow.db'))
  const db = database.db
  const store = new WorkflowCheckpointStore(db)
  const owner = {
    hostId: 'fixture-host',
    pid: 987654,
    processStartTimeMs: 1,
    spawnToken: 'previous'
  }
  const seat = {
    id: 'a',
    agent: openrouter ? 'openrouter' : 'claude',
    accountId: 'fixture',
    model: 'fixture-model',
    effort: null,
    lineage: 'anthropic',
    policyRevision: 'fixture'
  }
  const call: WorkflowProgramCall = {
    id: 'answers/a',
    seatId: 'a',
    prompt: 'frozen',
    dependencies: [],
    schema: {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false
    },
    validateSemantics: (value) =>
      (value as { answer: string }).answer === 'proof' ? null : 'Wrong answer'
  }
  const executionId = store.create({
    conversationId: 'c',
    requestId: 'r',
    snapshot: {
      version: 1,
      task: { prompt: 'frozen', evidence: '' },
      seats: spare ? [] : [seat],
      ...(spare ? { graph: { spareSeats: [seat] } } : {}),
      synthesizerId: 'a'
    },
    owner,
    preset: 'council',
    fence: 1,
    attemptLimit: 3,
    callLimit: 7,
    budgetLimit: 1
  })
  const inputDigest = workflowCallDigest(call, JSON.stringify(seat), seat.agent)
  const prepared = store.prepare({
    executionId,
    fence: 1,
    callId: call.id,
    inputDigest,
    reservation: 1,
    validate: () => {}
  })
  if (!('attemptId' in prepared)) {
    throw new Error('Expected attempt')
  }
  const ledger = join(directory, 'ledger')
  const output = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    structured_output: { answer: valid ? 'proof' : 'wrong' },
    session_id: 'fixture-session',
    modelUsage: { 'fixture-model': {} },
    usage: {}
  }
  const args = [
    '-e',
    `require('node:fs').appendFileSync(${JSON.stringify(ledger)}, 'spawn\\n'); process.stdout.write(${JSON.stringify(openrouter ? `${JSON.stringify({ type: 'init', session_id: prepared.attemptId })}\n${JSON.stringify({ type: 'result', model: 'fixture-model', requested_model: 'fixture-model', id: 'request', usage: { input_tokens: 3, output_tokens: 2, cost: 0.01 }, text: JSON.stringify(output.structured_output) })}` : JSON.stringify(output))})`
  ]
  const launch = createWorkflowLocalProcessLaunch({
    directory,
    executionId,
    fence: 1,
    hostId: owner.hostId,
    ownerIncarnation: owner.spawnToken,
    timeoutMs: 3000,
    maxOutputBytes: 4096,
    command: () => ({ program: process.execPath, args, input: call.prompt })
  })
  await launch({
    ...prepared,
    call,
    problems: null,
    signal: new AbortController().signal,
    recordPreparation: (identity) =>
      store.recordProcessPreparation(prepared.attemptId, 1, identity),
    recordLaunch: (ref) => store.recordLaunch(prepared.attemptId, 1, ref),
    recordNoLaunch: (reason) => store.recordNoLaunch(prepared.attemptId, 1, reason)
  })
  const transaction = <T>(work: () => T): T => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const value = work()
      db.exec('COMMIT')
      return value
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  await claimWorkflowOwner({
    db,
    transaction,
    executionId,
    expectedFence: 1,
    owner: await captureWorkflowOwner(owner.hostId),
    probe: async () => ({ outcome: 'pid-absent' })
  })
  const recovery = {
    attemptId: prepared.attemptId,
    fence: 2,
    call,
    attestNativeResult: () => {}
  }
  return { database, db, store, executionId, directory, ledger, recovery, inputDigest }
}

describe.skipIf(process.platform === 'win32')('recovery after owner transfer', () => {
  it('accepts saved native output without a new launch and replays at exhausted allowance', async () => {
    const f = await fixture()
    try {
      expect(f.store.readProcessIdentity(f.recovery.attemptId, 2).fence).toBe(1)
      expect(f.store.recoverAttempt(f.recovery)).toBe('accepted')
      expect(f.store.inspect(f.executionId, 2).state).toBe('paused')
      f.store.resume(f.executionId, 2)
      expect(
        f.store.prepare({
          executionId: f.executionId,
          fence: 2,
          callId: f.recovery.call.id,
          inputDigest: f.inputDigest,
          reservation: 1,
          validate: () => {}
        })
      ).toEqual({ cached: { answer: 'proof' } })
      expect(readFileSync(f.ledger, 'utf8')).toBe('spawn\n')
      expect(() => f.store.recoverAttempt(f.recovery)).toThrow('not recoverable')
      expect(() => f.store.readProcessIdentity(f.recovery.attemptId, 1)).toThrow('fence')
    } finally {
      f.database.close()
    }
  })
  it('recovers an attempt that ran on a frozen spare seat', async () => {
    const f = await fixture(true, false, true)
    try {
      expect(f.store.recoverAttempt(f.recovery)).toBe('accepted')
      expect(readFileSync(f.ledger, 'utf8')).toBe('spawn\n')
    } finally {
      f.database.close()
    }
  })
  it('recovers OpenRouter output without launching again', async () => {
    const f = await fixture(true, true)
    try {
      expect(f.store.recoverAttempt(f.recovery)).toBe('accepted')
      expect(readFileSync(f.ledger, 'utf8')).toBe('spawn\n')
    } finally {
      f.database.close()
    }
  })
  it('keeps failed native validation charged and never publishes it', async () => {
    const f = await fixture(false)
    try {
      expect(f.store.recoverAttempt(f.recovery)).toBe('failed')
      expect(f.db.prepare('SELECT result_json FROM local_workflow_calls').get()).toEqual({
        result_json: null
      })
      expect(f.db.prepare('SELECT budget_reserved FROM local_workflow_executions').get()).toEqual({
        budget_reserved: 1
      })
    } finally {
      f.database.close()
    }
  })
  it('charges recovered output rejected by native model attestation', async () => {
    const f = await fixture()
    try {
      const observed: string[] = []
      expect(
        f.store.recoverAttempt({
          ...f.recovery,
          attestNativeResult: ({ executionId, attemptId, route, seat, parsed }) => {
            observed.push(executionId, attemptId, route, seat.model, parsed.providerSessionId)
            throw new Error('Native model identity changed')
          }
        })
      ).toBe('failed')
      expect(observed).toEqual([
        f.executionId,
        f.recovery.attemptId,
        'claude',
        'fixture-model',
        'fixture-session'
      ])
      expect(f.db.prepare('SELECT result_json FROM local_workflow_calls').get()).toEqual({
        result_json: null
      })
      expect(f.db.prepare('SELECT budget_reserved FROM local_workflow_executions').get()).toEqual({
        budget_reserved: 1
      })
    } finally {
      f.database.close()
    }
  })
  it('honors stop intent while settling verified exit', async () => {
    const f = await fixture()
    try {
      f.store.requestControl(f.executionId, 2, 'stop')
      expect(f.store.recoverAttempt(f.recovery)).toBe('cancelled')
      expect(f.store.inspect(f.executionId, 2).state).toBe('cancelled')
      expect(f.db.prepare('SELECT result_json FROM local_workflow_calls').get()).toEqual({
        result_json: null
      })
    } finally {
      f.database.close()
    }
  })
  it('leaves missing exit evidence unresolved', async () => {
    const f = await fixture()
    try {
      rmSync(join(f.directory, f.recovery.attemptId, 'terminal.json'))
      expect(() => f.store.recoverAttempt(f.recovery)).toThrow()
      expect(f.store.inspect(f.executionId, 2).state).toBe('pausing')
      expect(f.db.prepare('SELECT state FROM local_workflow_attempts').get()).toEqual({
        state: 'running'
      })
      expect(readFileSync(f.ledger, 'utf8')).toBe('spawn\n')
    } finally {
      f.database.close()
    }
  })
  it('refuses changed call inputs and concurrent stop before commit', async () => {
    const f = await fixture()
    try {
      expect(() =>
        f.store.recoverAttempt({ ...f.recovery, call: { ...f.recovery.call, schema: {} } })
      ).toThrow('identity changed')
      expect(() =>
        f.store.recoverAttempt({
          ...f.recovery,
          call: {
            ...f.recovery.call,
            validateSemantics: () => {
              f.store.requestControl(f.executionId, 2, 'stop')
              return null
            }
          }
        })
      ).toThrow('evidence changed')
      expect(f.db.prepare('SELECT result_json FROM local_workflow_calls').get()).toEqual({
        result_json: null
      })
    } finally {
      f.database.close()
    }
  })
})
