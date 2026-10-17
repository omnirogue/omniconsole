import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import { SCHEMA_VERSION } from '../orchestration/db/contract-constants'
import { WorkflowCheckpointStore } from './workflow-checkpoint-store'

it.each([37, 38])(
  'repairs a missing owner table at version %i while preserving workflow records',
  (version) => {
    const directory = mkdtempSync(join(tmpdir(), 'workflow-owner-migrate-'))
    const path = join(directory, 'workflow.db')
    try {
      const before = new OrchestrationDb(path)
      const id = new WorkflowCheckpointStore(before.db).create({
        conversationId: 'c',
        requestId: 'r',
        snapshot: { retained: true },
        preset: 'council',
        fence: 1,
        attemptLimit: 3,
        callLimit: 7,
        budgetLimit: 3
      })
      before.db.exec(`DROP TABLE local_workflow_owners; PRAGMA user_version = ${version}`)
      before.close()
      const after = new OrchestrationDb(path)
      try {
        expect(after.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
        expect(
          after.db.prepare('SELECT COUNT(*) AS count FROM local_workflow_owners').get()
        ).toEqual({ count: 0 })
        expect(new WorkflowCheckpointStore(after.db).inspect(id, 1).snapshot).toEqual({
          retained: true
        })
      } finally {
        after.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
