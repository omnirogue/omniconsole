import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { OrchestrationDb } from '../orchestration-db'
import { SCHEMA_VERSION } from '../contract-constants'
import {
  applyWorkflowCallCeilingMigration,
  workflowTableCallCeiling
} from './migrate-workflow-call-ceiling'
import { applyWorkflowCallLimitMigration } from './migrate-workflow-call-limit'

const directories: string[] = []
afterEach(() =>
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
)

const insert = `INSERT INTO local_workflow_executions
  (id,conversation_id,request_id,snapshot_json,snapshot_digest,preset,fence,state,attempt_limit,call_limit,budget_limit)
  VALUES (?,?,?,'{}','d','discover',1,'running',3,?,?)`

function workingTableCount(db: OrchestrationDb): number {
  return (
    db.db
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('local_workflow_worker_calls','local_workflow_working_runs')"
      )
      .get() as { count: number }
  ).count
}

/** Rewrites a current database back to the v39 table, whose call limit stops at 30. */
function v39Database() {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-call-ceiling-'))
  directories.push(directory)
  const file = join(directory, 'orchestration.db')
  const initial = new OrchestrationDb(file)
  initial.db
    .prepare(`INSERT INTO local_workflow_executions
      (id,conversation_id,request_id,snapshot_json,snapshot_digest,preset,fence,state,sequence,attempt_limit,call_limit,budget_limit,budget_reserved)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      'existing',
      'conversation',
      'request',
      '{}',
      'digest',
      'discover',
      2,
      'paused',
      9,
      3,
      30,
      90,
      4
    )
  initial.db
    .prepare(`INSERT INTO local_workflow_calls
      (execution_id,call_id,input_digest,result_json,result_digest)
      VALUES (?,?,?,?,?)`)
    .run('existing', 'discover/correctness', 'input', '{}', 'result')
  initial.db
    .prepare(`INSERT INTO local_workflow_attempts
      (id,execution_id,call_id,ordinal,fence,state,reservation,receipt_json)
      VALUES (?,?,?,?,?,?,?,?)`)
    .run('attempt', 'existing', 'discover/correctness', 1, 2, 'accepted', 0, '{}')
  initial.db
    .prepare(
      'INSERT INTO local_workflow_owners (execution_id,owner_json,owner_digest) VALUES (?,?,?)'
    )
    .run('existing', '{}', 'owner-digest')
  initial.close()

  const raw = new DatabaseSync(file)
  const schema = raw
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='local_workflow_executions'"
    )
    .get() as { sql: string }
  const oldSchema = schema.sql
    .replace(
      /CREATE TABLE ["`]?local_workflow_executions["`]?/,
      'CREATE TABLE local_workflow_executions_v39'
    )
    .replace('call_limit BETWEEN 1 AND 400', 'call_limit BETWEEN 1 AND 30')
  expect(oldSchema).toContain('call_limit BETWEEN 1 AND 30')
  raw.exec('BEGIN IMMEDIATE')
  try {
    raw.exec(oldSchema)
    raw.exec('INSERT INTO local_workflow_executions_v39 SELECT * FROM local_workflow_executions')
    raw.exec('DROP TABLE local_workflow_executions')
    raw.exec('ALTER TABLE local_workflow_executions_v39 RENAME TO local_workflow_executions')
    raw.exec('PRAGMA user_version = 39')
    raw.exec('COMMIT')
  } catch (error) {
    raw.exec('ROLLBACK')
    throw error
  }
  return { file, raw }
}

describe('workflow call-ceiling schema migration', () => {
  it('upgrades v39 to 400 calls without losing execution or replay evidence', () => {
    expect(SCHEMA_VERSION).toBe(42)
    const { file, raw } = v39Database()
    raw.exec('DROP TABLE local_workflow_worker_calls')
    raw.exec('DROP TABLE local_workflow_working_runs')
    expect(() => raw.prepare(insert).run('too-early', 'c2', 'r2', 31, 93)).toThrow(
      /CHECK constraint/
    )
    raw.close()
    const upgraded = new OrchestrationDb(file)
    expect(upgraded.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    // v40's working-agent tables are created on the way to the v41 ceiling.
    expect(workingTableCount(upgraded)).toBe(2)
    expect(
      upgraded.db.prepare('SELECT * FROM local_workflow_executions WHERE id=?').get('existing')
    ).toMatchObject({
      conversation_id: 'conversation',
      request_id: 'request',
      state: 'paused',
      fence: 2,
      sequence: 9,
      attempt_limit: 3,
      call_limit: 30,
      budget_limit: 90,
      budget_reserved: 4
    })
    expect(upgraded.db.prepare('SELECT * FROM local_workflow_calls').get()).toMatchObject({
      execution_id: 'existing',
      call_id: 'discover/correctness',
      result_digest: 'result'
    })
    expect(upgraded.db.prepare('SELECT * FROM local_workflow_attempts').get()).toMatchObject({
      id: 'attempt',
      state: 'accepted'
    })
    expect(upgraded.db.prepare('SELECT * FROM local_workflow_owners').get()).toMatchObject({
      owner_digest: 'owner-digest'
    })
    upgraded.db.prepare(insert).run('full', 'c2', 'r2', 400, 1200)
    expect(() => upgraded.db.prepare(insert).run('too-many', 'c3', 'r3', 401, 1203)).toThrow(
      /CHECK constraint/
    )
    expect(() => upgraded.db.prepare(insert).run('none', 'c4', 'r4', 0, 0)).toThrow(
      /CHECK constraint/
    )
    expect(() =>
      upgraded.db.prepare(insert).run('duplicate', 'conversation', 'request', 30, 90)
    ).toThrow(/UNIQUE constraint/)
    expect(
      upgraded.db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='idx_local_workflow_attempts_execution'")
        .get()
    ).toBeTruthy()
    expect(upgraded.db.pragma('foreign_key_check')).toEqual([])
    upgraded.close()
  })

  it('upgrades a v40 working-agent database to the 400-call ceiling and keeps its bindings', () => {
    const { file, raw } = v39Database()
    raw
      .prepare(`INSERT INTO local_workflow_working_runs
        (execution_id,workspace_id,coordinator_handle,run_request_id,source_base,source_diff_digest,state)
        VALUES ('existing','workspace','handle','run-request','base','diff','running')`)
      .run()
    raw.exec('PRAGMA user_version = 40')
    expect(() => raw.prepare(insert).run('too-early', 'c2', 'r2', 31, 93)).toThrow(
      /CHECK constraint/
    )
    raw.close()
    const upgraded = new OrchestrationDb(file)
    expect(upgraded.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(workflowTableCallCeiling(upgraded.db)).toBe(400)
    expect(
      upgraded.db.prepare('SELECT * FROM local_workflow_executions WHERE id=?').get('existing')
    ).toMatchObject({ state: 'paused', call_limit: 30, budget_reserved: 4 })
    expect(
      upgraded.db.prepare('SELECT state FROM local_workflow_working_runs').get()
    ).toMatchObject({ state: 'running' })
    upgraded.db.prepare(insert).run('full', 'c2', 'r2', 400, 1200)
    upgraded.close()
  })

  it('repairs a pre-release v40 that stored the 400-call ceiling without working-agent tables', () => {
    const directory = mkdtempSync(join(tmpdir(), 'workflow-call-ceiling-'))
    directories.push(directory)
    const file = join(directory, 'orchestration.db')
    const current = new OrchestrationDb(file)
    current.db.prepare(insert).run('large', 'c1', 'r1', 160, 480)
    current.close()
    const raw = new DatabaseSync(file)
    raw.exec('DROP TABLE local_workflow_worker_calls')
    raw.exec('DROP TABLE local_workflow_working_runs')
    raw.exec('PRAGMA user_version = 40')
    raw.close()
    const repaired = new OrchestrationDb(file)
    expect(repaired.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(workingTableCount(repaired)).toBe(2)
    expect(
      repaired.db
        .prepare('SELECT call_limit FROM local_workflow_executions WHERE id=?')
        .get('large')
    ).toMatchObject({ call_limit: 160 })
    repaired.close()
  })

  it('fails closed when a database claims v41 but retains the 30-call constraint', () => {
    const { file, raw } = v39Database()
    raw.exec('PRAGMA user_version = 41')
    raw.close()
    expect(() => new OrchestrationDb(file)).toThrow(/v41 claims a workflow table/)
    const inspect = new DatabaseSync(file)
    expect(inspect.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 41 })
    inspect.close()
  })

  it('fails closed when a v40 database with working-agent tables lost its 30-call table', () => {
    const directory = mkdtempSync(join(tmpdir(), 'workflow-call-ceiling-'))
    directories.push(directory)
    const file = join(directory, 'orchestration.db')
    new OrchestrationDb(file).close()
    const raw = new DatabaseSync(file)
    raw.exec('PRAGMA user_version = 40')
    raw.close()
    expect(() => new OrchestrationDb(file)).toThrow(/v40 claims a workflow table/)
  })

  it('fails closed when a v40 database with the 30-call table lost its binding table', () => {
    const { file, raw } = v39Database()
    raw.exec('DROP TABLE local_workflow_worker_calls')
    raw.exec('PRAGMA user_version = 40')
    raw.close()
    expect(() => new OrchestrationDb(file)).toThrow(/v40 claims a working-agent table/)
  })

  it('replays the v39 step on a 400-call table without losing a large Discover run', () => {
    const directory = mkdtempSync(join(tmpdir(), 'workflow-call-ceiling-'))
    directories.push(directory)
    const current = new OrchestrationDb(join(directory, 'orchestration.db'))
    try {
      current.db.prepare(insert).run('large', 'c1', 'r1', 160, 480)
      expect(workflowTableCallCeiling(current.db)).toBe(400)
      // A version-skew repair restarts the chain from v6 inside one transaction.
      current.db.exec('BEGIN IMMEDIATE')
      applyWorkflowCallLimitMigration.call(current, 6)
      applyWorkflowCallCeilingMigration.call(current, 6)
      current.db.exec('COMMIT')
      expect(
        current.db
          .prepare('SELECT call_limit FROM local_workflow_executions WHERE id=?')
          .get('large')
      ).toMatchObject({ call_limit: 160 })
      expect(workflowTableCallCeiling(current.db)).toBe(400)
    } finally {
      current.close()
    }
  })

  it('rolls back a failed table copy without advancing user_version or losing rows', () => {
    const { file, raw } = v39Database()
    raw.exec('CREATE TABLE local_workflow_executions_v41 (blocker TEXT)')
    raw.close()
    expect(() => new OrchestrationDb(file)).toThrow(/already exists/)
    const inspect = new DatabaseSync(file)
    expect(inspect.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 39 })
    expect(
      inspect.prepare('SELECT call_limit FROM local_workflow_executions WHERE id=?').get('existing')
    ).toMatchObject({ call_limit: 30 })
    inspect.exec('DROP TABLE local_workflow_executions_v41')
    inspect.close()
    const repaired = new OrchestrationDb(file)
    expect(repaired.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    repaired.close()
  })
})
