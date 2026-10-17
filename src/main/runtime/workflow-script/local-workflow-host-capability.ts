import type Database from '../../sqlite/sync-database'
import { LOCAL_WORKFLOW_NOT_FOUND } from '../../../shared/session-workflow-anchor'
import { workflowEvidenceDigest } from './workflow-evidence-digest'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'

/**
 * Which execution service owns each run. The capability is frozen in the verified snapshot, so it
 * is read once. Unlike the store's inspect this does not refuse a run whose recovery is blocked:
 * that run still needs a tab status and a recovery view, and its capability decides which.
 */
export class LocalWorkflowCapabilities {
  private readonly working = new Map<string, boolean>()

  constructor(private readonly db: Database.Database) {}

  isWorking(executionId: string): boolean {
    let working = this.working.get(executionId)
    if (working === undefined) {
      const row = this.db
        .prepare('SELECT snapshot_json,snapshot_digest FROM local_workflow_executions WHERE id=?')
        .get(executionId) as { snapshot_json: string; snapshot_digest: string } | undefined
      if (!row) {
        throw new Error(LOCAL_WORKFLOW_NOT_FOUND)
      }
      if (workflowEvidenceDigest(row.snapshot_json) !== row.snapshot_digest) {
        throw new Error('Workflow snapshot integrity failure')
      }
      const envelope = JSON.parse(row.snapshot_json) as {
        snapshot?: Pick<LocalWorkflowHostSnapshot, 'capability'>
      }
      working = envelope.snapshot?.capability?.mode === 'working-agent'
      this.working.set(executionId, working)
    }
    return working
  }
}
