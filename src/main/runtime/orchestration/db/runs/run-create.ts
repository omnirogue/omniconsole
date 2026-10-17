import type { RunOrigin, RunRow } from '../../types'
import type { ConsoleJobBinding } from '../../../../../shared/console-workflow-types'
import { validateConsoleJobCorrelation } from '../../console-job-binding'
import {
  normalizeConsoleJobActivationReceipt,
  type ConsoleJobActivationReceipt
} from '../../console-job-activation-receipt'
import { validateHubBinding } from '../hub/hub-binding-validation'
import { resolveInheritedHubBinding } from '../hub/inherited-hub-binding'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'

// ── Runs ──

export function createRun(
  this: OrchestrationDb,
  params: {
    consoleJob?: ConsoleJobBinding
    consoleJobPrincipal?: string
    /** Main-only: the BFF's activation response. `orchestration.runCreate` refuses it. */
    consoleJobActivation?: ConsoleJobActivationReceipt
    hubTaskId?: string
    hubStateRevision?: number
    objective: string
    coordinatorHandle: string
    coordinatorPaneKey: string
    coordinatorProcessIncarnation?: string
  }
): RunRow {
  validateHubBinding(params)
  const id = generateId('run')
  this.db.exec('SAVEPOINT create_run')
  try {
    const binding = resolveInheritedHubBinding(this, params)
    const consoleJob = validateConsoleJobCorrelation({ ...params, hubTaskId: binding.hubTaskId })
    const activation =
      params.consoleJobActivation === undefined
        ? undefined
        : normalizeConsoleJobActivationReceipt(params.consoleJobActivation, requireBinding(consoleJob))
    this.unbindOtherRunsForPane(params.coordinatorPaneKey)
    this.db
      .prepare(
        `INSERT INTO runs (
           id, objective, coordinator_handle, coordinator_pane_key,
           consumer_generation, legacy, hub_task_id, hub_state_revision,
           console_job, console_job_principal, console_job_activation, origin
         ) VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.objective,
        params.coordinatorHandle,
        params.coordinatorPaneKey,
        binding.hubTaskId ?? null,
        binding.hubStateRevision ?? null,
        consoleJob ? JSON.stringify(consoleJob) : null,
        params.consoleJobPrincipal ?? null,
        activation ? JSON.stringify(activation) : null,
        resolveRunOrigin({
          consoleJob: consoleJob !== undefined,
          hubTaskId: binding.hubTaskId,
          canonicalOrigin: binding.canonicalOrigin
        })
      )
    this.rememberRunCoordinatorHandle(id, params.coordinatorHandle)
    this.db.exec('RELEASE create_run')
  } catch (error) {
    this.db.exec('ROLLBACK TO create_run')
    this.db.exec('RELEASE create_run')
    throw error
  }
  return this.getRun(id) as RunRow
}

/** Why: origin is derived from admission evidence the caller cannot forge -- the
 *  server-issued console job binding (already correlated to its card and signed
 *  person) or an inherited Hub-dispatched execution -- never from a request flag.
 *  Everything else a person binds from this dispatcher stays locally started. */
function resolveRunOrigin(evidence: {
  consoleJob: boolean
  hubTaskId?: string
  canonicalOrigin?: boolean
}): RunOrigin {
  if (evidence.consoleJob || (evidence.hubTaskId && evidence.canonicalOrigin)) {
    return 'hub_dispatched'
  }
  return evidence.hubTaskId ? 'local_bound' : 'personal'
}

/** An activation receipt without its binding has nothing to be a receipt for. */
function requireBinding(consoleJob: ConsoleJobBinding | undefined): ConsoleJobBinding {
  if (!consoleJob) {
    throw new Error('A console job activation receipt requires its console job binding.')
  }
  return consoleJob
}

export type RunCreateMethods = {
  createRun: typeof createRun
}

export function attachRunCreate(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    createRun
  })
}
