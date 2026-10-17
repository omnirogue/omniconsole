import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { OrchestrationDb } from '../orchestration-db'
import { SCHEMA_VERSION } from '../contract-constants'

const directories: string[] = []
afterEach(() =>
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
)

function databaseFile(): string {
  const path = mkdtempSync(join(tmpdir(), 'working-agent-migration-'))
  directories.push(path)
  return join(path, 'orchestration.db')
}

/** A real v39 table stops at 30 calls; the v41 ceiling is re-applied on upgrade. */
function restoreThirtyCallTable(raw: DatabaseSync): void {
  const { sql } = raw
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='local_workflow_executions'"
    )
    .get() as { sql: string }
  const v39 = sql
    .replace(/CREATE TABLE ["`]?local_workflow_executions["`]?/, 'CREATE TABLE executions_v39')
    .replace('call_limit BETWEEN 1 AND 400', 'call_limit BETWEEN 1 AND 30')
  expect(v39).toContain('call_limit BETWEEN 1 AND 30')
  raw.exec(v39)
  raw.exec('INSERT INTO executions_v39 SELECT * FROM local_workflow_executions')
  raw.exec('DROP TABLE local_workflow_executions')
  raw.exec('ALTER TABLE executions_v39 RENAME TO local_workflow_executions')
}

describe('working-agent Dispatch binding migration', () => {
  it('upgrades v39 in place and preserves existing workflow evidence', () => {
    const file = databaseFile()
    const created = new OrchestrationDb(file)
    created.db
      .prepare(`INSERT INTO local_workflow_executions
      (id,conversation_id,request_id,snapshot_json,snapshot_digest,preset,fence,state,attempt_limit,call_limit,budget_limit)
      VALUES ('existing','conversation','request','{}','digest','council',1,'completed',1,7,7)`)
      .run()
    created.close()
    const old = new DatabaseSync(file)
    old.exec('DROP TABLE local_workflow_worker_calls')
    restoreThirtyCallTable(old)
    old.exec('PRAGMA user_version = 39')
    old.close()
    const upgraded = new OrchestrationDb(file)
    expect(upgraded.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(
      upgraded.db.prepare('SELECT state FROM local_workflow_executions WHERE id=?').get('existing')
    ).toMatchObject({ state: 'completed' })
    expect(
      (
        upgraded.db.prepare('PRAGMA table_info(local_workflow_worker_calls)').all() as {
          name: string
        }[]
      ).some((column) => column.name === 'semantic_json')
    ).toBe(true)
    upgraded.close()
  })

  it('fails closed when a database claims the current version without its binding table', () => {
    const file = databaseFile()
    new OrchestrationDb(file).close()
    const raw = new DatabaseSync(file)
    raw.exec('DROP TABLE local_workflow_worker_calls')
    raw.close()
    expect(() => new OrchestrationDb(file)).toThrow(
      new RegExp(`v${SCHEMA_VERSION} claims a working-agent table`)
    )
  })
})
