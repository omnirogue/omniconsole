import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { resolveOrchestrationMigrationStartVersion } from './orchestration-schema-version-skew'
import { SCHEMA_VERSION } from './db/contract-constants'

/**
 * The startup prompt a failed readiness wait named is a decision input for the session recovery
 * ladder, so it has its own column: `last_error` stays the sentence a person reads.
 */
describe('worker startup blocker column (v36)', () => {
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

  function startingDispatch(database: OrchestrationDb, spec: string): string {
    // Why a Run: a run-less task lands in the legacy run, which the version-skew probe reads as an
    // unadopted pre-Run graph and answers by replaying migrations from v6.
    const run = database.createRun({
      objective: spec,
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = database.createTask({ spec, runId: run.id })
    return database.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: { topology: 'current', agent: 'codex' }
    }).dispatch.id
  }

  function createV35Database(): { dbPath: string; legacyDispatchId: string } {
    tempDir = mkdtempSync(join(tmpdir(), 'omni-startup-blocker-migration-'))
    const dbPath = join(tempDir, 'orchestration.db')
    const fresh = new OrchestrationDb(dbPath)
    const legacyDispatchId = startingDispatch(fresh, 'started by an older build')
    fresh.close()

    const oldDb = new Database(dbPath)
    oldDb.exec('ALTER TABLE worker_dispatches DROP COLUMN startup_blocker')
    oldDb.pragma('user_version = 35')
    // What a v35 build wrote for a blocked startup: the id exists only inside the sentence.
    oldDb
      .prepare(
        `UPDATE worker_dispatches
         SET state = 'failed', stage = 'agent_readiness', last_error = ?
         WHERE dispatch_id = ?`
      )
      .run('Agent startup blocked: codex-trust-workspace', legacyDispatchId)
    oldDb.close()
    return { dbPath, legacyDispatchId }
  }

  it('adds the column to a v35 database and leaves its rows unparsed', () => {
    const { dbPath, legacyDispatchId } = createV35Database()
    db = new OrchestrationDb(dbPath)
    const sqlite = (db as unknown as { db: Database.Database }).db

    expect(sqlite.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    // Never backfilled from prose: the reader keeps its sentence fallback for exactly these rows.
    expect(db.getWorkerDispatch(legacyDispatchId)).toMatchObject({
      state: 'failed',
      stage: 'agent_readiness',
      last_error: 'Agent startup blocked: codex-trust-workspace',
      startup_blocker: null
    })
  })

  it('does not mistake a real v35 database for a broken v36 one', () => {
    const { dbPath } = createV35Database()
    const oldDb = new Database(dbPath)
    expect(resolveOrchestrationMigrationStartVersion(oldDb, 35, SCHEMA_VERSION)).toBe(35)
    oldDb.close()
  })

  it('records the blocker id beside an unchanged human-readable reason', () => {
    db = new OrchestrationDb(':memory:')
    const dispatchId = startingDispatch(db, 'blocked at startup')

    const worker = db.failWorkerStart(
      dispatchId,
      'agent_readiness',
      'Agent startup blocked: codex-hooks-review-prompt',
      { startupBlocker: 'codex-hooks-review-prompt' }
    )

    expect(worker).toMatchObject({
      state: 'failed',
      stage: 'agent_readiness',
      last_error: 'Agent startup blocked: codex-hooks-review-prompt',
      startup_blocker: 'codex-hooks-review-prompt'
    })
    expect(db.getDispatchContextById(dispatchId)).toMatchObject({
      status: 'failed',
      last_failure: 'Agent startup blocked: codex-hooks-review-prompt'
    })
  })

  it('leaves the column null for a start that failed for any other reason', () => {
    db = new OrchestrationDb(':memory:')
    const dispatchId = startingDispatch(db, 'never became ready')

    const worker = db.failWorkerStart(
      dispatchId,
      'agent_readiness',
      'Agent did not become ready (running).'
    )

    expect(worker).toMatchObject({ state: 'failed', startup_blocker: null })
  })
})
