import type { WorkerCompletionPolicy } from '../../../../shared/orchestration-worker-completion-policy'
import { getWorktreeExecutionHostId } from '../../../../shared/execution-host'
import type { Worktree } from '../../../../shared/worktree/types'
import type { OrcaRuntimeService } from '../../omni-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { readAutomaticWorkerCleanupHold } from '../../automatic-worker-cleanup-hold'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { WorkerStartInput } from './orchestration-worker-start-schema'

export async function resolveWorkerCompletionHostId(
  runtime: OrcaRuntimeService,
  worktree: Pick<Worktree, 'hostId'> & { repoId?: string }
): Promise<string | undefined> {
  if (worktree.hostId) {
    return worktree.hostId
  }
  if (!worktree.repoId) {
    return undefined
  }
  try {
    const repo = await runtime.showRepo(`id:${worktree.repoId}`)
    return getWorktreeExecutionHostId(worktree, repo)
  } catch {
    // The repo is not proven. Do not infer local ownership from a missing row.
    return undefined
  }
}

export function assertWorkerCompletionPolicyPlacement(params: WorkerStartInput): void {
  if (params.closeOnCompletion && process.platform === 'win32') {
    throw new OrchestrationError(
      'invalid_argument',
      '--close-on-completion requires local descendant process ownership unavailable on Windows.'
    )
  }
  if (
    params.closeOnCompletion &&
    !params.on &&
    !params.terminal &&
    !['claude', 'codex'].includes(params.agent ?? '')
  ) {
    throw new OrchestrationError(
      'invalid_argument',
      '--close-on-completion requires Claude or Codex account-resume evidence on this host.'
    )
  }
  if (params.closeOnCompletion && (params.on || params.terminal)) {
    throw new OrchestrationError(
      'invalid_argument',
      '--close-on-completion requires a newly created local worker; remote owner release and existing-terminal opt-in are unsupported.'
    )
  }
}

export async function assertWorkerCompletionPolicyAllowed(
  runtime: OrcaRuntimeService,
  policy: WorkerCompletionPolicy,
  worker: { worktreeId: string; paneKey?: string }
): Promise<void> {
  const hold = await readWorkerCompletionPolicyHold(runtime, policy, worker)
  if (hold) {
    throw workerCompletionPolicyHoldError(hold)
  }
}

export function workerCompletionPolicyHoldError(hold: string): OrchestrationError {
  return new OrchestrationError(
    'invalid_argument',
    `--close-on-completion is held by ${hold}; this worker requires manual lifecycle control.`
  )
}

async function readWorkerCompletionPolicyHold(
  runtime: OrcaRuntimeService,
  policy: WorkerCompletionPolicy,
  worker: { worktreeId: string; paneKey?: string }
): Promise<string | null> {
  const coordinatorHold = await readAutomaticWorkerCleanupHold(runtime, policy.coordinator)
  // Why the worker only: the coordinator's own open Question never holds its workers' release.
  return (
    coordinatorHold ??
    (await readAutomaticWorkerCleanupHold(runtime, worker, { questionWait: true }))
  )
}

export async function prepareWorkerCompletionPolicy(
  runtime: OrcaRuntimeService,
  params: WorkerStartInput,
  coordinator: WorkerCompletionPolicy['coordinator'],
  workerWorktreeId: string,
  agent: string | undefined,
  workerHostId: string | undefined
): Promise<WorkerCompletionPolicy | undefined> {
  const automatic =
    params.closeOnCompletion === undefined &&
    !params.terminal &&
    process.platform !== 'win32' &&
    workerHostId === 'local' &&
    (agent === 'claude' || agent === 'codex')
  if (!params.closeOnCompletion && !automatic) {
    return undefined
  }
  const policy: WorkerCompletionPolicy = { kind: 'release_on_accepted_completion', coordinator }
  const hold = await readWorkerCompletionPolicyHold(runtime, policy, {
    worktreeId: workerWorktreeId
  })
  if (hold) {
    if (automatic) {
      return undefined
    }
    throw workerCompletionPolicyHoldError(hold)
  }
  return policy
}

export async function checkSpawnedWorkerCompletionPolicy(
  runtime: OrcaRuntimeService,
  policy: WorkerCompletionPolicy | undefined,
  worktreeId: string,
  terminalHandle: string
): Promise<string | null> {
  if (!policy) {
    return null
  }
  const paneKey = runtime.getTerminalPaneKey(terminalHandle)
  if (!paneKey) {
    return 'protection-unknown'
  }
  return readWorkerCompletionPolicyHold(runtime, policy, { worktreeId, paneKey })
}

export async function settleSpawnedWorkerCompletionPolicy(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  params: WorkerStartInput
  policy: WorkerCompletionPolicy | undefined
  worktreeId: string
  terminalHandle: string
  dispatchId: string
  startOptions: Record<string, unknown>
}): Promise<void> {
  if (!args.policy) {
    return
  }
  const hold = await checkSpawnedWorkerCompletionPolicy(
    args.runtime,
    args.policy,
    args.worktreeId,
    args.terminalHandle
  )
  if (hold && args.params.closeOnCompletion) {
    throw workerCompletionPolicyHoldError(hold)
  }
  if (hold) {
    return
  }
  const changed = args.db.db
    .prepare(
      `UPDATE worker_dispatches SET start_options = ?
       WHERE dispatch_id = ? AND state = 'starting'`
    )
    .run(JSON.stringify({ ...args.startOptions, completionPolicy: args.policy }), args.dispatchId)
  if (changed.changes !== 1) {
    throw new Error('Worker completion policy could not be committed before dispatch.')
  }
}
