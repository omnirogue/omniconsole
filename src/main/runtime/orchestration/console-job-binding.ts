import type { ConsoleJobBinding } from '../../../shared/console-workflow-types'
import { ConsoleJobBindingSchema } from './console-job-binding-schema'
import type { OrchestrationDb } from './db/orchestration-db'

export function normalizeConsoleJobBinding(binding: ConsoleJobBinding): ConsoleJobBinding {
  const parsed = ConsoleJobBindingSchema.safeParse(binding)
  if (!parsed.success) {
    throw new Error(
      'A console job requires its server-issued card, job and complete claim or start binding.'
    )
  }
  return parsed.data
}

export function validateConsoleJobCorrelation(params: {
  consoleJob?: ConsoleJobBinding
  consoleJobPrincipal?: string
  hubTaskId?: string
}): ConsoleJobBinding | undefined {
  if (!params.consoleJob) {
    if (params.consoleJobPrincipal !== undefined) {
      throw new Error('Publication provenance requires a console job binding.')
    }
    return undefined
  }
  const binding = normalizeConsoleJobBinding(params.consoleJob)
  if (binding.claim && binding.sessionId !== undefined) {
    throw new Error('A claimed job attaches its start receipt after Run and Dispatch creation.')
  }
  if (binding.taskId !== params.hubTaskId) {
    throw new Error('The console job must bind to the same admitted hub card.')
  }
  if (!/^[a-f0-9]{64}$/.test(params.consoleJobPrincipal ?? '')) {
    throw new Error('A console job requires its signed-person publication principal digest.')
  }
  return binding
}

export function getConsoleJobBinding(db: OrchestrationDb, runId: string): ConsoleJobBinding | null {
  const run = db.getRun(runId)
  if (!run?.console_job) {
    return null
  }
  const binding = validateConsoleJobCorrelation({
    consoleJob: JSON.parse(run.console_job) as ConsoleJobBinding,
    consoleJobPrincipal: run.console_job_principal ?? undefined,
    hubTaskId: run.hub_task_id ?? undefined
  })!
  if (!run.console_job_start_receipt) {
    return binding
  }
  const receipt = JSON.parse(run.console_job_start_receipt) as {
    dispatchId: string
    sessionId: string
    attemptId: string
    inputDigest?: string
  }
  if (
    !binding.claim ||
    binding.sessionId !== undefined ||
    !run.console_job_dispatch_id ||
    receipt.dispatchId !== run.console_job_dispatch_id
  ) {
    throw new Error('The console job start receipt does not match its immutable Dispatch binding.')
  }
  assertDispatchBinding(db, runId, receipt.dispatchId, binding.taskId)
  return normalizeConsoleJobBinding({
    ...binding,
    sessionId: receipt.sessionId,
    attemptId: receipt.attemptId,
    ...(receipt.inputDigest === undefined ? {} : { inputDigest: receipt.inputDigest })
  })
}

export function getConsoleJobBindingForDispatch(
  db: OrchestrationDb,
  dispatchId: string
): ConsoleJobBinding | null {
  const dispatch = db.getDispatchContextById(dispatchId)
  if (!dispatch) {
    return null
  }
  const task = db.getTask(dispatch.task_id)
  const binding = getConsoleJobBinding(db, dispatch.run_id)
  if (binding && (task?.run_id !== dispatch.run_id || dispatch.hub_task_id !== binding.taskId)) {
    throw new Error('The dispatch and console job must share the same admitted run and card.')
  }
  if (binding?.claim && db.getRun(dispatch.run_id)?.console_job_dispatch_id !== dispatchId) {
    throw new Error('The dispatch must be the one pinned to this console job claim.')
  }
  return binding
}

type ConsoleJobDispatchBinding = {
  runId: string
  dispatchId: string
  principal: string
  binding: ConsoleJobBinding
}

function assertDispatchBinding(
  db: OrchestrationDb,
  runId: string,
  dispatchId: string,
  taskId: string
): void {
  const dispatch = db.getDispatchContextById(dispatchId)
  const task = dispatch && db.getTask(dispatch.task_id)
  if (
    !dispatch ||
    dispatch.run_id !== runId ||
    dispatch.hub_task_id !== taskId ||
    task?.run_id !== runId ||
    task.hub_task_id !== taskId
  ) {
    throw new Error('The dispatch and console job must share the same admitted run and card.')
  }
}

function assertOriginalClaim(
  db: OrchestrationDb,
  params: ConsoleJobDispatchBinding
): ConsoleJobBinding {
  const run = db.getRun(params.runId)
  const original = run?.console_job
    ? validateConsoleJobCorrelation({
        consoleJob: JSON.parse(run.console_job),
        consoleJobPrincipal: run.console_job_principal ?? undefined,
        hubTaskId: run.hub_task_id ?? undefined
      })
    : null
  const candidate = normalizeConsoleJobBinding(params.binding)
  if (
    !original?.claim ||
    original.sessionId !== undefined ||
    run?.console_job_principal !== params.principal ||
    JSON.stringify(original) !==
      JSON.stringify(
        normalizeConsoleJobBinding({
          ...candidate,
          sessionId: undefined,
          attemptId: undefined,
          ...(original.inputDigest === undefined && candidate.sessionId !== undefined
            ? { inputDigest: undefined }
            : {})
        })
      )
  ) {
    throw new Error('The original person and complete console job claim must match exactly.')
  }
  assertDispatchBinding(db, params.runId, params.dispatchId, original.taskId)
  return candidate
}

/** Commit the claim's sole Dispatch before the closed launch gate calls started. */
export function bindConsoleJobDispatch(
  db: OrchestrationDb,
  params: ConsoleJobDispatchBinding
): void {
  db.db.exec('BEGIN IMMEDIATE')
  try {
    const candidate = assertOriginalClaim(db, params)
    if (candidate.sessionId !== undefined) {
      throw new Error('Pin the unstarted activation claim before attaching its start receipt.')
    }
    if (db.getRun(params.runId)?.console_job_dispatch_id !== params.dispatchId) {
      db.db
        .prepare('UPDATE runs SET console_job_dispatch_id = ? WHERE id = ?')
        .run(params.dispatchId, params.runId)
    }
    db.db.exec('COMMIT')
  } catch (error) {
    db.db.exec('ROLLBACK')
    throw error
  }
}

/** Attach only the started response's real IDs; an exact replay has no second write. */
export function attachConsoleJobStartReceipt(
  db: OrchestrationDb,
  params: ConsoleJobDispatchBinding
): ConsoleJobBinding {
  db.db.exec('BEGIN IMMEDIATE')
  try {
    const candidate = assertOriginalClaim(db, params)
    const run = db.getRun(params.runId)!
    if (
      !candidate.sessionId ||
      !candidate.attemptId ||
      run.console_job_dispatch_id !== params.dispatchId
    ) {
      throw new Error(
        "The start receipt requires both actual hub IDs and the claim's pinned Dispatch."
      )
    }
    const receipt = JSON.stringify({
      dispatchId: params.dispatchId,
      sessionId: candidate.sessionId,
      attemptId: candidate.attemptId,
      ...(candidate.inputDigest === undefined ? {} : { inputDigest: candidate.inputDigest })
    })
    if (run.console_job_start_receipt && run.console_job_start_receipt !== receipt) {
      throw new Error('The console job start receipt is already immutable for this Dispatch.')
    }
    if (!run.console_job_start_receipt) {
      db.db
        .prepare('UPDATE runs SET console_job_start_receipt = ? WHERE id = ?')
        .run(receipt, params.runId)
    }
    db.db.exec('COMMIT')
    return candidate
  } catch (error) {
    db.db.exec('ROLLBACK')
    throw error
  }
}
