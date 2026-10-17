import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../../../sqlite/sync-database'
import { OrchestrationDb } from '../orchestration-db'
import { SCHEMA_VERSION } from '../contract-constants'
import { consoleJobClaimFixture, consoleJobPrincipalFixture } from '../../console-job-test-fixture'
import { createRootDispatch } from '../root-dispatch-test-fixture'
import { createHubTaskProjection } from '../tasks/task-store'

/**
 * Why this exists: `hub_task_id` records which omnios card an execution reports
 * to, never who owns it. Before the stored origin, every card-bound Run looked
 * like a Hub-dispatched canonical execution, so Build + Review and
 * `run-create --hub-task-id` -- work a signed-in person starts on this
 * dispatcher -- were refused their own worker-start.
 */
describe('run execution origin', () => {
  const principal = consoleJobPrincipalFixture
  let db: OrchestrationDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  function sqliteOf(instance: OrchestrationDb): Database.Database {
    return (instance as unknown as { db: Database.Database }).db
  }

  function createV33Database(): string {
    tempDir = mkdtempSync(join(tmpdir(), 'omni-run-origin-migration-'))
    const dbPath = join(tempDir, 'orchestration.db')
    const fresh = new OrchestrationDb(dbPath)
    fresh.close()

    const oldDb = new Database(dbPath)
    oldDb.exec('DROP TRIGGER IF EXISTS trg_runs_origin_admission')
    oldDb.exec('DROP TRIGGER IF EXISTS trg_runs_origin_escalation_only')
    oldDb.exec('ALTER TABLE runs DROP COLUMN origin')
    oldDb.pragma('user_version = 33')
    oldDb
      .prepare(
        `INSERT INTO runs (id, objective, hub_task_id, console_job, console_job_principal)
         VALUES ('run_admitted', 'Console job', 'btk_admitted', ?, ?)`
      )
      .run(JSON.stringify({ taskId: 'btk_admitted', jobId: 'job_1' }), principal)
    oldDb
      .prepare(
        `INSERT INTO runs (id, objective, hub_task_id) VALUES ('run_bound', 'Bound', 'btk_bound')`
      )
      .run()
    oldDb.prepare(`INSERT INTO runs (id, objective) VALUES ('run_local', 'Ad hoc')`).run()
    oldDb.close()
    return dbPath
  }

  function origins(instance: OrchestrationDb): Record<string, string> {
    const rows = sqliteOf(instance).prepare('SELECT id, origin FROM runs ORDER BY id').all() as {
      id: string
      origin: string
    }[]
    return Object.fromEntries(rows.map((row) => [row.id, row.origin]))
  }

  it('backfills existing rows from the admission evidence they already carry', () => {
    const dbPath = createV33Database()
    db = new OrchestrationDb(dbPath)

    expect(sqliteOf(db).pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(origins(db)).toEqual({
      run_admitted: 'hub_dispatched',
      run_bound: 'local_bound',
      run_local: 'personal',
      // The adopted legacy Run has no card at all, so it stays personal.
      run_legacy_local: 'personal'
    })
  })

  it('refuses to flip a hub-dispatched run back to a locally started one', () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Canonical',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    db.bindRunToHub({ runId: run.id, hubTaskId: 'btk_canonical' })
    expect(db.getRun(run.id)?.origin).toBe('hub_dispatched')

    for (const forged of ['local_bound', 'personal']) {
      expect(() =>
        sqliteOf(db!).prepare('UPDATE runs SET origin = ? WHERE id = ?').run(forged, run.id)
      ).toThrow(/only escalates to hub_dispatched/)
    }
    expect(db.getRun(run.id)?.origin).toBe('hub_dispatched')
  })

  it('refuses to store a console job admission as a locally started run', () => {
    db = new OrchestrationDb(':memory:')
    for (const forged of ['local_bound', 'personal']) {
      expect(() =>
        sqliteOf(db!)
          .prepare(
            `INSERT INTO runs (id, objective, hub_task_id, console_job, console_job_principal, origin)
             VALUES ('run_forged', 'Forged', 'btk_forged', ?, ?, ?)`
          )
          .run(JSON.stringify({ taskId: 'btk_forged', jobId: 'job_1' }), principal, forged)
      ).toThrow(/must match its card binding and console job admission/)
    }
    expect(sqliteOf(db).prepare("SELECT 1 FROM runs WHERE id = 'run_forged'").get()).toBeUndefined()
  })

  it('refuses an unbound run that claims a card-bound origin', () => {
    db = new OrchestrationDb(':memory:')
    expect(() =>
      sqliteOf(db!)
        .prepare("INSERT INTO runs (id, objective, origin) VALUES ('run_claim', 'Claim', ?)")
        .run('local_bound')
    ).toThrow(/must match its card binding and console job admission/)
    expect(() =>
      sqliteOf(db!)
        .prepare(
          "INSERT INTO runs (id, objective, hub_task_id, origin) VALUES ('run_claim', 'Claim', 'btk_claim', ?)"
        )
        .run('personal')
    ).toThrow(/must match its card binding and console job admission/)
  })

  it('records the person-bound IDE run as local_bound and the console job as hub_dispatched', () => {
    db = new OrchestrationDb(':memory:')
    const local = db.createRun({
      objective: 'Build + Review',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord',
      hubTaskId: 'btk_person'
    })
    expect(local.origin).toBe('local_bound')

    const admitted = db.createRun({
      objective: 'Console job',
      coordinatorHandle: 'term_console',
      coordinatorPaneKey: 'tab_console:leaf_console',
      hubTaskId: consoleJobClaimFixture.taskId,
      consoleJobPrincipal: principal,
      consoleJob: consoleJobClaimFixture
    })
    expect(admitted.origin).toBe('hub_dispatched')

    const personal = db.createRun({
      objective: 'Ad hoc',
      coordinatorHandle: 'term_solo',
      coordinatorPaneKey: 'tab_solo:leaf_solo'
    })
    expect(personal.origin).toBe('personal')
  })

  it('keeps a run created inside a hub-dispatched execution canonical', () => {
    db = new OrchestrationDb(':memory:')
    const admitted = db.createRun({
      objective: 'Console job',
      coordinatorHandle: 'term_console',
      coordinatorPaneKey: 'tab_console:leaf_console',
      hubTaskId: consoleJobClaimFixture.taskId,
      consoleJobPrincipal: principal,
      consoleJob: consoleJobClaimFixture
    })
    const task = createHubTaskProjection(db, {
      runId: admitted.id,
      hubTaskId: consoleJobClaimFixture.taskId
    })
    createRootDispatch(db, task.id, 'term_worker', 'tab_worker:leaf_worker')

    // Why: without inherited ownership the canonical worker could open a sibling
    // Run for the same card and start local workers outside Hub admission.
    const nested = db.createRun({
      objective: 'Sub-workers for the admitted job',
      coordinatorHandle: 'term_worker',
      coordinatorPaneKey: 'tab_worker:leaf_worker'
    })
    expect(nested.hub_task_id).toBe(consoleJobClaimFixture.taskId)
    expect(nested.origin).toBe('hub_dispatched')
  })
})
