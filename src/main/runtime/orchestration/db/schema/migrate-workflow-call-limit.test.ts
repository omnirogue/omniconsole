import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { OrchestrationDb } from '../orchestration-db'
import { SCHEMA_VERSION } from '../contract-constants'

const directories: string[] = []
afterEach(() =>
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
)

function oldDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-call-limit-'))
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
      28,
      84,
      1
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
      'CREATE TABLE local_workflow_executions_v38'
    )
    .replace('call_limit BETWEEN 1 AND 400', 'call_limit BETWEEN 1 AND 28')
  expect(oldSchema).toContain('call_limit BETWEEN 1 AND 28')
  raw.exec('BEGIN IMMEDIATE')
  try {
    raw.exec(oldSchema)
    raw.exec('INSERT INTO local_workflow_executions_v38 SELECT * FROM local_workflow_executions')
    raw.exec('DROP TABLE local_workflow_executions')
    raw.exec('ALTER TABLE local_workflow_executions_v38 RENAME TO local_workflow_executions')
    raw.exec('PRAGMA user_version = 38')
    raw.exec('COMMIT')
  } catch (error) {
    raw.exec('ROLLBACK')
    throw error
  }
  return { file, raw }
}

describe('workflow call-limit schema migration', () => {
  it('upgrades v38 through the current call ceiling without losing execution or replay evidence', () => {
    const { file, raw } = oldDatabase()
    expect(() =>
      raw
        .prepare(`INSERT INTO local_workflow_executions
        (id,conversation_id,request_id,snapshot_json,snapshot_digest,preset,fence,state,attempt_limit,call_limit,budget_limit)
        VALUES ('too-early','c2','r2','{}','d','discover',1,'running',3,30,90)`)
        .run()
    ).toThrow(/CHECK constraint/)
    raw.close()
    const upgraded = new OrchestrationDb(file)
    // v39 raised the ceiling to 30 calls, v40 added working-agent tables and v41 raised it to 400.
    expect(upgraded.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(
      upgraded.db.prepare('SELECT * FROM local_workflow_executions WHERE id=?').get('existing')
    ).toMatchObject({
      conversation_id: 'conversation',
      request_id: 'request',
      state: 'paused',
      fence: 2,
      sequence: 9,
      attempt_limit: 3,
      call_limit: 28,
      budget_limit: 84,
      budget_reserved: 1
    })
    expect(upgraded.db.prepare('SELECT * FROM local_workflow_calls').get()).toMatchObject({
      execution_id: 'existing',
      call_id: 'discover/correctness',
      input_digest: 'input',
      result_json: '{}',
      result_digest: 'result'
    })
    expect(upgraded.db.prepare('SELECT * FROM local_workflow_attempts').get()).toMatchObject({
      id: 'attempt',
      execution_id: 'existing',
      ordinal: 1,
      state: 'accepted',
      receipt_json: '{}'
    })
    expect(upgraded.db.prepare('SELECT * FROM local_workflow_owners').get()).toMatchObject({
      execution_id: 'existing',
      owner_digest: 'owner-digest'
    })
    upgraded.db
      .prepare(`INSERT INTO local_workflow_executions
      (id,conversation_id,request_id,snapshot_json,snapshot_digest,preset,fence,state,attempt_limit,call_limit,budget_limit)
      VALUES ('new','c2','r2','{}','d','discover',1,'running',3,30,90)`)
      .run()
    expect(() =>
      upgraded.db
        .prepare(`INSERT INTO local_workflow_executions
      (id,conversation_id,request_id,snapshot_json,snapshot_digest,preset,fence,state,attempt_limit,call_limit,budget_limit)
      VALUES ('too-many','c3','r3','{}','d','discover',1,'running',3,401,1203)`)
        .run()
    ).toThrow(/CHECK constraint/)
    expect(() =>
      upgraded.db
        .prepare(`INSERT INTO local_workflow_executions
      (id,conversation_id,request_id,snapshot_json,snapshot_digest,preset,fence,state,attempt_limit,call_limit,budget_limit)
      VALUES ('duplicate','conversation','request','{}','d','discover',1,'running',3,30,90)`)
        .run()
    ).toThrow(/UNIQUE constraint/)
    expect(() =>
      upgraded.db
        .prepare(`INSERT INTO local_workflow_executions
      (id,conversation_id,request_id,snapshot_json,snapshot_digest,preset,fence,state,attempt_limit,call_limit,budget_limit)
      VALUES ('bad-state','c4','r4','{}','d','discover',1,'wrong',3,30,90)`)
        .run()
    ).toThrow(/CHECK constraint/)
    for (const table of [
      'local_workflow_calls',
      'local_workflow_attempts',
      'local_workflow_owners'
    ]) {
      expect(
        (upgraded.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
      ).toBe(1)
    }
    expect(
      upgraded.db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='idx_local_workflow_attempts_execution'")
        .get()
    ).toBeTruthy()
    expect(upgraded.db.pragma('foreign_key_check')).toEqual([])
    upgraded.close()
  })

  it('fails closed when a database claims v39 but retains the v38 call constraint', () => {
    const { file, raw } = oldDatabase()
    raw.exec('PRAGMA user_version = 39')
    raw.close()
    expect(() => new OrchestrationDb(file)).toThrow(/v39 claims a workflow table/)
    const inspect = new DatabaseSync(file)
    expect(inspect.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 39 })
    expect(
      inspect.prepare('SELECT call_limit FROM local_workflow_executions WHERE id=?').get('existing')
    ).toMatchObject({ call_limit: 28 })
    inspect.close()
  })

  it('rolls back a failed schema copy without advancing user_version or losing rows', () => {
    const { file, raw } = oldDatabase()
    raw.exec('CREATE TABLE local_workflow_executions_v39 (blocker TEXT)')
    raw.close()
    expect(() => new OrchestrationDb(file)).toThrow(/already exists/)
    const inspect = new DatabaseSync(file)
    expect(inspect.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 38 })
    expect(
      inspect.prepare('SELECT call_limit FROM local_workflow_executions WHERE id=?').get('existing')
    ).toMatchObject({ call_limit: 28 })
    inspect.exec('DROP TABLE local_workflow_executions_v39')
    inspect.close()
    const repaired = new OrchestrationDb(file)
    expect(repaired.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    repaired.close()
  })
})
