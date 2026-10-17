import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConsoleJobBinding } from '../../../shared/console-workflow-types'
import { getConsoleJobBinding, getConsoleJobBindingForDispatch } from './console-job-binding'
import {
  consoleJobFixture,
  consoleJobPrincipalFixture,
  createConsoleJobRun
} from './console-job-test-fixture'
import { OrchestrationDb } from './db/orchestration-db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import { createHubTaskProjection } from './db/tasks/task-store'
import { SCHEMA_VERSION } from './db/contract-constants'

describe('immutable console job correlation on existing runtime records', () => {
  let path: string
  let directory: string
  let db: OrchestrationDb
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'omni-job-binding-'))
    path = join(directory, 'orchestration.db')
    db = new OrchestrationDb(path)
  })
  afterEach(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('reopens actual server identities and resolves task/dispatch links without copying a ledger', () => {
    const binding = {
      ...consoleJobFixture,
      contractId: 'contract_server',
      contractDigest: 'c'.repeat(64),
      contractGeneration: 1,
      inputDigest: 'd'.repeat(64)
    }
    const run = createConsoleJobRun(db, binding)
    const task = createHubTaskProjection(db, { runId: run.id, hubTaskId: consoleJobFixture.taskId })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    db.close()
    db = new OrchestrationDb(path)
    expect(getConsoleJobBinding(db, run.id)).toEqual(binding)
    expect(getConsoleJobBindingForDispatch(db, dispatch.id)).toEqual(binding)
    expect(db.getTask(task.id)?.run_id).toBe(run.id)
    expect(db.getRun(run.id)?.console_job_principal).toBe(consoleJobPrincipalFixture)
    expect(() =>
      db.db.prepare('UPDATE runs SET console_job = NULL WHERE id = ?').run(run.id)
    ).toThrow('run creation')
    expect(() =>
      db.db
        .prepare('UPDATE runs SET console_job_principal = ? WHERE id = ?')
        .run('b'.repeat(64), run.id)
    ).toThrow('run creation')
  })

  it('refuses a duplicate job attempt before disturbing the current coordinator binding', () => {
    const run = createConsoleJobRun(db)
    expect(() => createConsoleJobRun(db)).toThrow('UNIQUE')
    expect(db.getCurrentRunForPane(`tab:${consoleJobFixture.jobId}`)?.id).toBe(run.id)
    const next = createConsoleJobRun(db, {
      ...consoleJobFixture,
      attempt: 2,
      leaseGeneration: 4,
      attemptId: 'attempt_next',
      sessionId: 'ses_next'
    })
    expect(getConsoleJobBinding(db, next.id)?.attempt).toBe(2)
    expect(getConsoleJobBinding(db, run.id)?.attempt).toBe(1)
  })

  it.each([
    { taskId: 'btk_other' },
    { attempt: 0 },
    { leaseGeneration: 0 },
    { sessionId: '' },
    { attemptId: undefined },
    { workflowId: undefined }
  ])('refuses missing or mismatched server correlation: %j', (patch) => {
    expect(() =>
      db.createRun({
        objective: 'Work',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: 'tab:coord',
        hubTaskId: consoleJobFixture.taskId,
        consoleJob: { ...consoleJobFixture, ...patch } as ConsoleJobBinding,
        consoleJobPrincipal: consoleJobPrincipalFixture
      })
    ).toThrow()
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM runs WHERE legacy = 0').get()).toEqual({
      count: 0
    })
  })

  it('requires original-person provenance and keeps older no-job runs compatible', () => {
    expect(() =>
      db.createRun({
        objective: 'Work',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: 'tab:coord',
        hubTaskId: consoleJobFixture.taskId,
        consoleJob: consoleJobFixture
      })
    ).toThrow('principal digest')
    const old = db.createRun({
      objective: 'Ad hoc',
      coordinatorHandle: 'term_old',
      coordinatorPaneKey: 'tab:old'
    })
    expect(getConsoleJobBinding(db, old.id)).toBeNull()
    expect(() =>
      db.db
        .prepare('UPDATE runs SET console_job = ? WHERE id = ?')
        .run(JSON.stringify(consoleJobFixture), old.id)
    ).toThrow('run creation')
  })

  it('upgrades a real v31 database and leaves existing runs unbound', () => {
    const old = db.createRun({
      objective: 'Existing',
      coordinatorHandle: 'term_old',
      coordinatorPaneKey: 'tab:old'
    })
    db.db.exec(`DROP TRIGGER trg_runs_console_job_activation_insert;
      DROP TRIGGER trg_runs_console_job_activation_immutable;
      ALTER TABLE runs DROP COLUMN console_job_activation;
      DROP TRIGGER trg_runs_origin_admission;
      DROP TRIGGER trg_runs_origin_escalation_only; ALTER TABLE runs DROP COLUMN origin;
      DROP INDEX idx_runs_console_job_dispatch;
      DROP TRIGGER trg_runs_console_job_start_insert; DROP TRIGGER trg_runs_console_job_dispatch;
      DROP TRIGGER trg_runs_console_job_start_receipt;
      ALTER TABLE runs DROP COLUMN console_job_dispatch_id; ALTER TABLE runs DROP COLUMN console_job_start_receipt;
      DROP INDEX idx_runs_console_job_attempt;
      DROP TRIGGER trg_runs_immutable_console_job; DROP TRIGGER trg_runs_console_job_card;
      DROP TABLE console_job_publications;
      ALTER TABLE runs DROP COLUMN console_job; ALTER TABLE runs DROP COLUMN console_job_principal;
      PRAGMA user_version = 31;`)
    db.close()
    db = new OrchestrationDb(path)
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(db.getRun(old.id)?.console_job).toBeNull()
    expect(getConsoleJobBinding(db, createConsoleJobRun(db).id)).toEqual(consoleJobFixture)
  })
})
