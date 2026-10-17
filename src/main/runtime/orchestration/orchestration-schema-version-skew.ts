import type Database from '../../sqlite/sync-database'

const POST_V6_COLUMNS = [
  ['messages', 'run_id'],
  ['messages', 'delivery_contract'],
  ['coordinator_runs', 'scheduler_lost_at'],
  ['tasks', 'run_id'],
  ['dispatch_contexts', 'run_id'],
  ['dispatch_contexts', 'contract_version'],
  ['dispatch_contexts', 'launch_token_hash'],
  ['dispatch_contexts', 'capability_hash'],
  ['dispatch_contexts', 'process_incarnation'],
  ['dispatch_contexts', 'capability_revoked_at'],
  ['decision_gates', 'run_id'],
  ['question_threads', 'run_id'],
  ['worker_dispatches', 'runtime_epoch'],
  ['federated_dispatches', 'to_home_imported_sequence'],
  ['remote_dispatch_attachments', 'to_worker_imported_sequence'],
  ['remote_dispatch_attachments', 'protocol_version'],
  ['federation_relay_items', 'dispatch_id'],
  ['remote_questions', 'message_id'],
  ['legacy_adoptions', 'source_run_id'],
  ['legacy_compatibility_principals', 'id'],
  ['legacy_operation_receipts', 'principal_id'],
  ['legacy_mail_receipts', 'principal_id']
] as const

const VERSIONED_POST_V6_COLUMNS = [
  ...['execution_id', 'call_id', 'digest'].map((column) => ({
    version: 42,
    table: 'local_workflow_web_starts',
    column
  })),
  { version: 40, table: 'local_workflow_worker_calls', column: 'semantic_digest' },
  { version: 38, table: 'local_workflow_owners', column: 'owner_digest' },
  { version: 38, table: 'local_workflow_owners', column: 'owner_json' },
  { version: 37, table: 'local_workflow_executions', column: 'snapshot_digest' },
  { version: 37, table: 'local_workflow_calls', column: 'result_digest' },
  { version: 37, table: 'local_workflow_attempts', column: 'reservation' },
  { version: 36, table: 'worker_dispatches', column: 'startup_blocker' },
  { version: 35, table: 'runs', column: 'console_job_activation' },
  { version: 34, table: 'runs', column: 'origin' },
  { version: 33, table: 'runs', column: 'console_job_dispatch_id' },
  { version: 33, table: 'runs', column: 'console_job_start_receipt' },
  { version: 32, table: 'runs', column: 'console_job' },
  { version: 32, table: 'runs', column: 'console_job_principal' },
  { version: 32, table: 'console_job_publications', column: 'observation_id' },
  ...[
    'runs',
    'tasks',
    'dispatch_contexts',
    'worker_dispatches',
    'remote_dispatch_attachments'
  ].flatMap((table) => [
    { version: 31, table, column: 'hub_task_id' },
    { version: 31, table, column: 'hub_state_revision' }
  ]),
  { version: 31, table: 'tasks', column: 'hub_next_action' },
  { version: 31, table: 'decision_gates', column: 'decision_scope' },
  { version: 27, table: 'federated_dispatches', column: 'to_home_acknowledged_sequence' },
  { version: 30, table: 'dispatch_contexts', column: 'depth' },
  { version: 30, table: 'remote_dispatch_attachments', column: 'depth' }
] as const

const POST_V6_INDEXES = [
  'idx_messages_run_sequence',
  'idx_messages_delivery_contract',
  'idx_tasks_run_status',
  'idx_dispatch_run_status',
  'idx_gates_run_status',
  'idx_runs_coordinator_pane',
  'idx_deliveries_one_outstanding',
  'idx_deliveries_run_created',
  'idx_questions_dispatch_status',
  'idx_federation_relay_pending',
  'idx_remote_questions_dispatch_status'
] as const

function hasOrchestrationColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.pragma(`table_info(${table})`) as { name: string }[]
  return rows.some((row) => row.name === column)
}

function hasOrchestrationIndex(db: Database.Database, index: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(index)
}

function messagesAllowQuestions(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
    .get() as { sql: string } | undefined
  return !!row && row.sql.includes("'question'")
}

function hasWorkflowCallLimit(db: Database.Database, ceiling: number): boolean {
  const row = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'local_workflow_executions'"
    )
    .get() as { sql: string } | undefined
  return (
    !!row && new RegExp(`call_limit\\s+BETWEEN\\s+1\\s+AND\\s+${ceiling}\\b`, 'i').test(row.sql)
  )
}

/** A version that claims a workflow call ceiling must carry its table constraint. */
const WORKFLOW_CALL_CEILINGS: Record<number, number> = { 39: 30, 40: 30, 41: 400, 42: 400 }

function hasConsistentLegacyAdoption(db: Database.Database): boolean {
  const sourceRunId = 'run_legacy_local'
  const sourceGraph = db
    .prepare(
      `SELECT 1
       WHERE EXISTS(SELECT 1 FROM tasks WHERE run_id = ?)
          OR EXISTS(SELECT 1 FROM dispatch_contexts WHERE run_id = ?)
          OR EXISTS(SELECT 1 FROM decision_gates WHERE run_id = ?)
          OR EXISTS(SELECT 1 FROM messages WHERE run_id = ?)
          OR EXISTS(SELECT 1 FROM question_threads WHERE run_id = ?)
          OR EXISTS(SELECT 1 FROM deliveries WHERE run_id = ?)`
    )
    .get(sourceRunId, sourceRunId, sourceRunId, sourceRunId, sourceRunId, sourceRunId)
  const adoption = db
    .prepare('SELECT adopted_run_id FROM legacy_adoptions WHERE source_run_id = ?')
    .get(sourceRunId) as { adopted_run_id: string } | undefined
  if (sourceGraph) {
    return false
  }
  if (adoption) {
    return Boolean(
      db.prepare('SELECT 1 FROM runs WHERE id = ? AND legacy = 0').get(adoption.adopted_run_id)
    )
  }
  return true
}

function hasCompletePostV6Schema(db: Database.Database, storedVersion: number): boolean {
  return (
    POST_V6_COLUMNS.every(([table, column]) => hasOrchestrationColumn(db, table, column)) &&
    VERSIONED_POST_V6_COLUMNS.every(
      ({ version, table, column }) =>
        storedVersion < version || hasOrchestrationColumn(db, table, column)
    ) &&
    POST_V6_INDEXES.every((index) => hasOrchestrationIndex(db, index)) &&
    messagesAllowQuestions(db) &&
    hasConsistentLegacyAdoption(db)
  )
}

/**
 * v40 added the working-agent tables. A pre-release build stored the 400-call ceiling (now v41) as
 * v40 without them; replaying from v39 creates the tables and finds the ceiling already applied.
 */
function claimedWorkflowVersion(
  db: Database.Database,
  storedVersion: number,
  schemaVersion: number
): number {
  if (
    storedVersion < 40 ||
    storedVersion > schemaVersion ||
    hasOrchestrationColumn(db, 'local_workflow_worker_calls', 'semantic_digest')
  ) {
    return storedVersion
  }
  if (storedVersion === 40 && hasWorkflowCallLimit(db, 400)) {
    return 39
  }
  throw new Error(
    `Orchestration v${storedVersion} claims a working-agent table that is missing or incomplete`
  )
}

export function resolveOrchestrationMigrationStartVersion(
  db: Database.Database,
  storedVersion: number,
  schemaVersion: number
): number {
  const claimed = claimedWorkflowVersion(db, storedVersion, schemaVersion)
  const ceiling = claimed === storedVersion ? WORKFLOW_CALL_CEILINGS[storedVersion] : undefined
  if (
    ceiling !== undefined &&
    hasOrchestrationColumn(db, 'local_workflow_executions', 'snapshot_digest') &&
    !hasWorkflowCallLimit(db, ceiling)
  ) {
    throw new Error(
      `Orchestration v${storedVersion} claims a workflow table without the ${ceiling}-call constraint`
    )
  }
  if (storedVersion > schemaVersion) {
    return storedVersion
  }
  if (hasCompletePostV6Schema(db, claimed)) {
    return claimed
  }
  // Why: version-skewed pre-Run databases can claim the post-v6 range while retaining v6 tables.
  return Math.min(claimed, schemaVersion, 6)
}
