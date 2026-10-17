import { applyWorkflowOwnerMigration } from './migrate-workflow-owners'
import { resolveOrchestrationMigrationStartVersion } from '../../orchestration-schema-version-skew'
import { applyLocalWorkflowMigration } from './migrate-local-workflows'
import { SCHEMA_VERSION } from '../contract-constants'
import type { OrchestrationDb } from '../orchestration-db'
import { applySchemaMigrationsV13ToV30 } from './migrate-v13-v30'
import { applySchemaMigrationsV2ToV12 } from './migrate-v2-v12'
import { applyHubBindingMigration } from './migrate-hub-binding'
import { applyConsoleJobPublicationMigration } from './migrate-console-job-publication'
import { applyRunOriginMigration } from './migrate-run-origin'
import { applyConsoleJobActivationMigration } from './migrate-console-job-activation'
import { applyWorkerStartupBlockerMigration } from './migrate-worker-startup-blocker'
import { applyWorkflowCallLimitMigration } from './migrate-workflow-call-limit'
import { applyWorkflowWorkerCallsMigration } from './migrate-workflow-worker-calls'
import { applyWorkflowCallCeilingMigration } from './migrate-workflow-call-ceiling'
import { applyWorkflowWebStartsMigration } from './migrate-workflow-web-starts'

// Why: CREATE TABLE IF NOT EXISTS won't alter existing DBs; migrate in a txn that bumps user_version only on success (atomic all-or-nothing).
export function migrate(this: OrchestrationDb): void {
  const storedVersion = this.db.pragma('user_version', { simple: true }) as number
  const current = resolveOrchestrationMigrationStartVersion(this.db, storedVersion, SCHEMA_VERSION)
  if (current >= SCHEMA_VERSION) {
    return
  }

  this.db.exec('BEGIN IMMEDIATE')
  try {
    applySchemaMigrationsV2ToV12.call(this, current)
    applySchemaMigrationsV13ToV30.call(this, current)
    applyHubBindingMigration.call(this, current)
    applyConsoleJobPublicationMigration.call(this, current)
    applyRunOriginMigration.call(this, current)
    applyConsoleJobActivationMigration.call(this, current)
    applyWorkerStartupBlockerMigration.call(this, current)
    applyLocalWorkflowMigration.call(this, current)
    applyWorkflowOwnerMigration.call(this, current)
    applyWorkflowCallLimitMigration.call(this, current)
    applyWorkflowWorkerCallsMigration.call(this, current)
    applyWorkflowCallCeilingMigration.call(this, current)
    applyWorkflowWebStartsMigration.call(this, current)
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`)
    this.db.exec('COMMIT')
  } catch (err) {
    this.db.exec('ROLLBACK')
    throw err
  }
}

export type SchemaMigrateMethods = {
  migrate: typeof migrate
}

export function attachSchemaMigrate(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    migrate
  })
}
