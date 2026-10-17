import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConsoleJobBinding } from '../../../shared/console-workflow-types'
import {
  attachConsoleJobStartReceipt,
  bindConsoleJobDispatch,
  getConsoleJobBinding,
  getConsoleJobBindingForDispatch
} from './console-job-binding'
import { ConsoleJobBindingSchema } from './console-job-binding-schema'
import { ConsoleJobJournal } from './console-job-journal'
import {
  consoleJobClaimFixture,
  consoleJobFixture,
  consoleJobPrincipalFixture,
  createConsoleJobRun
} from './console-job-test-fixture'
import { SCHEMA_VERSION } from './db/contract-constants'
import { OrchestrationDb } from './db/orchestration-db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import { createHubTaskProjection } from './db/tasks/task-store'
import { recordHubExecutionObservation } from './hub-execution-observation'

describe('activation claim followed by the real started receipt', () => {
  let directory: string
  let path: string
  let db: OrchestrationDb
  const claim = consoleJobClaimFixture
  const started: ConsoleJobBinding = {
    ...claim,
    sessionId: 'ses_server_started',
    attemptId: 'attempt_server_started',
    inputDigest: 'd'.repeat(64)
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'omni-job-start-binding-'))
    path = join(directory, 'orchestration.db')
    db = new OrchestrationDb(path)
  })
  afterEach(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })

  function reopen() {
    db.close()
    db = new OrchestrationDb(path)
  }

  function prepare() {
    const run = createConsoleJobRun(db, claim)
    const task = createHubTaskProjection(db, { runId: run.id, hubTaskId: claim.taskId })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    return {
      runId: run.id,
      dispatchId: dispatch.id,
      principal: consoleJobPrincipalFixture,
      binding: claim
    }
  }

  function retryDispatch(dispatchId: string) {
    const dispatch = db.getDispatchContextById(dispatchId)!
    db.db.prepare("UPDATE dispatch_contexts SET status = 'failed' WHERE id = ?").run(dispatchId)
    db.db.prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(dispatch.task_id)
    return createRootDispatch(db, dispatch.task_id, 'term_retry')
  }

  it('persists an unstarted claim, then pins and attaches exactly once across real restarts', () => {
    const input = prepare()
    const original = db.getRun(input.runId)!.console_job
    reopen()
    expect(getConsoleJobBinding(db, input.runId)).toEqual(claim)
    expect(JSON.parse(original!)).not.toHaveProperty('sessionId')
    expect(JSON.parse(original!)).not.toHaveProperty('attemptId')
    expect(() => getConsoleJobBindingForDispatch(db, input.dispatchId)).toThrow('pinned')
    expect(() => attachConsoleJobStartReceipt(db, { ...input, binding: started })).toThrow('pinned')

    bindConsoleJobDispatch(db, input)
    reopen()
    expect(getConsoleJobBindingForDispatch(db, input.dispatchId)).toEqual(claim)
    expect(attachConsoleJobStartReceipt(db, { ...input, binding: started })).toEqual(started)
    const receipt = db.getRun(input.runId)!.console_job_start_receipt
    expect(JSON.parse(receipt!)).toEqual({
      dispatchId: input.dispatchId,
      sessionId: started.sessionId,
      attemptId: started.attemptId,
      inputDigest: started.inputDigest
    })
    reopen()
    const before = db.db.prepare('SELECT total_changes() AS count').get()
    bindConsoleJobDispatch(db, input)
    expect(attachConsoleJobStartReceipt(db, { ...input, binding: started })).toEqual(started)
    expect(db.db.prepare('SELECT total_changes() AS count').get()).toEqual(before)
    expect(getConsoleJobBinding(db, input.runId)).toEqual(started)
    expect(getConsoleJobBindingForDispatch(db, input.dispatchId)).toEqual(started)
    expect(db.getRun(input.runId)!.console_job).toBe(original)
    expect(db.getRun(input.runId)!.console_job_start_receipt).toBe(receipt)
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 1 })
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM dispatch_contexts').get()).toEqual({
      count: 1
    })
    expect(db.getRun(input.runId)!.console_job_principal).toBe(consoleJobPrincipalFixture)
  })

  it.each([
    { taskId: 'btk_other' },
    { workflowId: 'workflow_other' },
    { jobId: 'job_other' },
    { attempt: 2 },
    { leaseGeneration: 4 },
    { contractId: 'contract_other' },
    { contractDigest: 'e'.repeat(64) },
    { contractGeneration: 2 },
    ...[
      { host: 'local:emp_other' },
      { claimedAt: '2026-09-08T00:00:00.123457+00:00' },
      { runnerInstance: 'orca_worker_other' },
      { claimRequestId: 'orca_dispatch_other' },
      { attemptIntentId: 'att_intent_other' },
      { dispatchKey: 'server:dispatch:other' }
    ].map((patch) => ({ claim: { ...claim.claim!, ...patch } }))
  ])('refuses a changed activation claim at both binding steps: %j', (patch) => {
    const input = prepare()
    expect(() => bindConsoleJobDispatch(db, { ...input, binding: { ...claim, ...patch } })).toThrow(
      'match exactly'
    )
    expect(db.getRun(input.runId)!.console_job_dispatch_id).toBeNull()
    bindConsoleJobDispatch(db, input)
    expect(() =>
      attachConsoleJobStartReceipt(db, { ...input, binding: { ...started, ...patch } })
    ).toThrow('match exactly')
    expect(getConsoleJobBinding(db, input.runId)).toEqual(claim)
    expect(db.getRun(input.runId)!.console_job_start_receipt).toBeNull()
  })

  it.each([
    { sessionId: 'ses_other' },
    { attemptId: 'attempt_other' },
    { inputDigest: 'e'.repeat(64) },
    { inputDigest: undefined }
  ])('refuses changed IDs or digest after attachment: %j', (patch) => {
    const input = prepare()
    bindConsoleJobDispatch(db, input)
    attachConsoleJobStartReceipt(db, { ...input, binding: started })
    reopen()
    expect(() =>
      attachConsoleJobStartReceipt(db, { ...input, binding: { ...started, ...patch } })
    ).toThrow('immutable')
    expect(getConsoleJobBinding(db, input.runId)).toEqual(started)
  })

  it('refuses another person, an absent Dispatch and a Dispatch from another Run', () => {
    const input = prepare()
    const other = createConsoleJobRun(db, { ...claim, jobId: 'job_other' })
    const task = createHubTaskProjection(db, { runId: other.id, hubTaskId: claim.taskId })
    const dispatch = createRootDispatch(db, task.id, 'term_other')
    for (const patch of [
      { principal: 'b'.repeat(64) },
      { dispatchId: 'ctx_absent' },
      { dispatchId: dispatch.id },
      { runId: other.id }
    ]) {
      expect(() => bindConsoleJobDispatch(db, { ...input, ...patch })).toThrow()
      expect(() =>
        attachConsoleJobStartReceipt(db, { ...input, ...patch, binding: started })
      ).toThrow()
    }
    expect(db.getRun(input.runId)!.console_job_dispatch_id).toBeNull()
    expect(db.getRun(input.runId)!.console_job_start_receipt).toBeNull()
  })

  it('pins the original Dispatch against a retry in the same Run, including before started', () => {
    const input = prepare()
    bindConsoleJobDispatch(db, input)
    const retry = retryDispatch(input.dispatchId)
    expect(() => bindConsoleJobDispatch(db, { ...input, dispatchId: retry.id })).toThrow('pinned')
    expect(() =>
      attachConsoleJobStartReceipt(db, { ...input, dispatchId: retry.id, binding: started })
    ).toThrow('pinned')
    expect(() => getConsoleJobBindingForDispatch(db, retry.id)).toThrow('pinned')
    attachConsoleJobStartReceipt(db, { ...input, binding: started })
    expect(() =>
      attachConsoleJobStartReceipt(db, { ...input, dispatchId: retry.id, binding: started })
    ).toThrow('pinned')
    expect(getConsoleJobBindingForDispatch(db, input.dispatchId)).toEqual(started)
  })

  it('enforces immutability in SQLite even when bypassing the API', () => {
    const input = prepare()
    bindConsoleJobDispatch(db, input)
    attachConsoleJobStartReceipt(db, { ...input, binding: started })
    for (const [column, value] of [
      ['console_job', JSON.stringify({ ...claim, leaseGeneration: 4 })],
      ['console_job_principal', 'b'.repeat(64)],
      ['console_job_dispatch_id', null],
      ['console_job_start_receipt', null],
      [
        'console_job_start_receipt',
        JSON.stringify({
          dispatchId: input.dispatchId,
          sessionId: 'ses_other',
          attemptId: started.attemptId
        })
      ]
    ]) {
      expect(() =>
        db.db.prepare(`UPDATE runs SET ${column} = ? WHERE id = ?`).run(value, input.runId)
      ).toThrow()
    }
    expect(getConsoleJobBinding(db, input.runId)).toEqual(started)
  })

  it('refuses an enclosing transaction so no start attachment can escape a caller rollback', () => {
    const input = prepare()
    db.db.exec('BEGIN IMMEDIATE')
    expect(() => bindConsoleJobDispatch(db, input)).toThrow('transaction')
    db.db.exec('ROLLBACK')
    bindConsoleJobDispatch(db, input)
    db.db.exec('BEGIN IMMEDIATE')
    expect(() => attachConsoleJobStartReceipt(db, { ...input, binding: started })).toThrow(
      'transaction'
    )
    db.db.exec('ROLLBACK')
    expect(db.getRun(input.runId)!.console_job_start_receipt).toBeNull()
  })

  it('keeps the original outbox identity and redaction while future observations carry the receipt', () => {
    const input = prepare()
    const secret = 'protected-token-sentinel'
    const sanitize = (text: string) => text.replaceAll(secret, '[redacted]')
    const observation = recordHubExecutionObservation(db, {
      runId: input.runId,
      event: 'run_started',
      detail: `${secret} ${input.runId}`
    })!.observation
    new ConsoleJobJournal(db, sanitize).capture(observation)
    const pending = new ConsoleJobJournal(db, sanitize).pending()[0]
    expect(JSON.parse(pending.payload).binding).toEqual(claim)
    expect(pending.payload).not.toContain(secret)
    expect(pending.payload).not.toContain(input.runId)
    bindConsoleJobDispatch(db, input)
    attachConsoleJobStartReceipt(db, { ...input, binding: started })
    reopen()
    const journal = new ConsoleJobJournal(db, sanitize)
    journal.capture(observation)
    expect(journal.pending()[0]).toEqual(pending)
    journal.capture(
      recordHubExecutionObservation(db, {
        runId: input.runId,
        workerDispatchId: input.dispatchId,
        event: 'worker_exit'
      })!.observation
    )
    expect(JSON.parse(journal.pending()[1].payload).binding).toEqual(started)
    const retry = retryDispatch(input.dispatchId)
    const wrong = recordHubExecutionObservation(db, {
      runId: input.runId,
      workerDispatchId: retry.id,
      event: 'worker_exit'
    })!.observation
    expect(() => journal.capture(wrong)).toThrow('pinned')
    expect(journal.pending()).toHaveLength(2)
  })

  it('migrates a v32 database without inventing receipts or changing queued legacy publications', () => {
    const legacy = createConsoleJobRun(db)
    const journal = new ConsoleJobJournal(db, (text) => text)
    journal.capture(
      recordHubExecutionObservation(db, { runId: legacy.id, event: 'run_started' })!.observation
    )
    const pending = journal.pending()
    const tables = db.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
    db.db.exec(`DROP INDEX idx_runs_console_job_dispatch;
      DROP TRIGGER trg_runs_console_job_start_insert; DROP TRIGGER trg_runs_console_job_dispatch;
      DROP TRIGGER trg_runs_console_job_start_receipt;
      ALTER TABLE runs DROP COLUMN console_job_dispatch_id; ALTER TABLE runs DROP COLUMN console_job_start_receipt;
      PRAGMA user_version = 32;`)
    reopen()
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(
      db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    ).toEqual(tables)
    expect(getConsoleJobBinding(db, legacy.id)).toEqual(consoleJobFixture)
    expect(db.getRun(legacy.id)!.console_job_dispatch_id).toBeNull()
    expect(db.getRun(legacy.id)!.console_job_start_receipt).toBeNull()
    expect(new ConsoleJobJournal(db, (text) => text).pending()).toEqual(pending)
  })

  it('accepts old wire fixtures and requires complete new claims without retaining unknown fields', () => {
    expect(ConsoleJobBindingSchema.parse(consoleJobFixture)).toEqual(consoleJobFixture)
    expect(ConsoleJobBindingSchema.parse(claim)).toEqual(claim)
    expect(ConsoleJobBindingSchema.parse(started)).toEqual(started)
    const run = createConsoleJobRun(db, {
      ...claim,
      source_grant: 'private',
      task_context: 'private'
    } as ConsoleJobBinding)
    expect(db.getRun(run.id)!.console_job).not.toContain('private')
    expect(() => createConsoleJobRun(db, started)).toThrow('after Run and Dispatch creation')
    for (const key of Object.keys(claim.claim!)) {
      expect(
        ConsoleJobBindingSchema.safeParse({
          ...claim,
          claim: { ...claim.claim, [key]: undefined }
        }).success
      ).toBe(false)
    }
    for (const value of [
      { ...claim, claim: undefined },
      { ...claim, sessionId: 'ses_partial' },
      { ...claim, attemptId: 'attempt_partial' },
      { ...claim, claim: { ...claim.claim, claimedAt: 'not-a-timestamp' } }
    ]) {
      expect(ConsoleJobBindingSchema.safeParse(value).success).toBe(false)
    }
  })
})
