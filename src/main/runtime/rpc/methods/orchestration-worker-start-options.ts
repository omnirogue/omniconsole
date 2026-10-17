import type { TuiAgent } from '../../../../shared/tui-agent'
import type { OrchestrationWorkerLaunchReceipt } from './orchestration-worker-launch-preferences'
import type { WorkerStartInput } from './orchestration-worker-start-schema'

/**
 * The durable record of what this worker-start was asked for. It is stored on the
 * Dispatch, so a later inspection can say exactly which workspace, folder, account
 * and agent the worker was launched with without re-deriving any of it.
 */
export function buildWorkerStartOptions(args: {
  params: WorkerStartInput
  requestedWorktree: string
  resolvedWorktreeId: string | null
  creationRepoId: string | null
  createsWorktree: boolean
  workerCwd: string | undefined
  agent: TuiAgent | undefined
  launchReceipt: OrchestrationWorkerLaunchReceipt
  readinessTimeoutMs: number
}): Record<string, unknown> {
  const { params, createsWorktree } = args
  return {
    ...(params.continueFrom ? { continueFrom: params.continueFrom } : {}),
    ...(params.executionBrief !== undefined ? { executionBrief: params.executionBrief } : {}),
    ...(params.consoleExecution ? { consoleExecution: params.consoleExecution } : {}),
    worktree: args.requestedWorktree,
    resolvedWorktreeId: args.resolvedWorktreeId,
    cwd: args.workerCwd ?? null,
    accountChoiceId: params.accountChoiceId ?? null,
    name: params.name ?? null,
    repo: params.repo ?? args.creationRepoId,
    baseBranch: params.baseBranch ?? null,
    terminal: params.terminal ?? null,
    agent: args.agent ?? null,
    launch: args.launchReceipt,
    timeoutMs: args.readinessTimeoutMs,
    setup: createsWorktree ? (params.setup ?? 'run') : 'not_applicable',
    setupSource: createsWorktree
      ? params.setup
        ? 'explicit_request'
        : 'orchestration_default'
      : 'existing_worktree'
  }
}
