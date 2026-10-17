import type { OrchestrationDb } from '../orchestration-db'

/** A start row for every call of a run: the record of which web calls began was lost. */
export const WORKFLOW_WEB_STARTS_LOST = '*'

const COLUMNS = ['execution_id', 'call_id', 'digest']

// Admitted under web rules is what lets a run read pages at all (workflow-preset-runner.ts).
function readsWeb(snapshotJson: string): boolean {
  try {
    const host = (JSON.parse(snapshotJson) as { snapshot?: { host?: { webRules?: unknown } } })
      .snapshot?.host
    return host?.webRules !== undefined
  } catch {
    return true
  }
}

/** v42: web-call starts, kept before any fetch; at v42 a lost table marks every web run started. */
export function applyWorkflowWebStartsMigration(this: OrchestrationDb, current: number): void {
  const columns = (
    this.db.pragma('table_info(local_workflow_web_starts)') as { name: string }[]
  ).map((row) => row.name)
  if (COLUMNS.every((name) => columns.includes(name))) {
    return
  }
  const lost = current >= 42 || (this.db.pragma('user_version', { simple: true }) as number) >= 42
  if (columns.length) {
    this.db.exec('DROP TABLE local_workflow_web_starts')
  }
  this.db.exec(`
    CREATE TABLE local_workflow_web_starts (
      execution_id TEXT NOT NULL,
      call_id TEXT NOT NULL,
      digest TEXT NOT NULL,
      PRIMARY KEY (execution_id, call_id)
    );
  `)
  if (!lost) {
    return
  }
  const runs = this.db.prepare('SELECT id, snapshot_json FROM local_workflow_executions').all() as {
    id: string
    snapshot_json: string
  }[]
  const mark = this.db.prepare(
    'INSERT INTO local_workflow_web_starts (execution_id, call_id, digest) VALUES (?, ?, ?)'
  )
  for (const run of runs.filter((entry) => readsWeb(entry.snapshot_json))) {
    mark.run(run.id, WORKFLOW_WEB_STARTS_LOST, 'lost')
  }
}
