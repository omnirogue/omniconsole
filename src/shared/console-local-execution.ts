import type { ConsoleAutoAdvanceApi } from './console-auto-advance'
import type { ConsoleWorkflowResult } from './console-workflow-types'
import type { OrchestrationWorkerReadResult } from './orchestration-worker-output'

export type ConsoleLocalExecutionView = {
  jobId: string
  workflowId: string
  cardId: string
  runId: string
  dispatchId: string | null
  terminalHandle: string | null
  worktreeId: string
  branch: string | null
  state: 'starting' | 'running' | 'pr_open' | 'failed' | 'cancelled' | 'exited' | 'unverifiable'
  error?: string
}

export type ConsoleLocalStartRequest = {
  jobId: string
  workflowId: string
  approvedDigest: string
  worktree: string
}

export type ConsoleTaskContinuationRequest = {
  operationId: string
  taskId: string
  goalId?: string
  threadId?: string
  agent: 'claude' | 'codex' | 'grok' | 'omp'
  model: string
  openrouterCandidates?: string[]
  effort?: string
  instruction: string
  worktree: string
}

export type ConsoleTaskContinuationCapability = {
  available: boolean
  reason?: string
  openrouter_routing?: boolean
}

export type ConsoleLocalExecutionApi = {
  start(
    request: ConsoleLocalStartRequest
  ): Promise<ConsoleWorkflowResult<ConsoleLocalExecutionView>>
  list(): Promise<ConsoleWorkflowResult<ConsoleLocalExecutionView[]>>
  cancel(request: { jobId: string }): Promise<ConsoleWorkflowResult<ConsoleLocalExecutionView>>
  readWorker(request: {
    jobId: string
    cursor?: string | number
    limit?: number
  }): Promise<ConsoleWorkflowResult<OrchestrationWorkerReadResult>>
  focus(request: { jobId: string }): Promise<ConsoleWorkflowResult<null>>
}

/**
 * What the renderer holds: the local execution operations plus the auto-advance preference.
 * Auto-advance rides this surface because it activates only through this same local path; the
 * main-side execution service itself never reads or writes the preference.
 */
export type ConsoleLocalExecutionClientApi = ConsoleLocalExecutionApi &
  ConsoleAutoAdvanceApi & {
    /** Negotiated with this signed person's server; absent on older desktop hosts. */
    taskContinuationCapabilities?(request?: {
      taskId?: string
    }): Promise<ConsoleWorkflowResult<ConsoleTaskContinuationCapability>>
    /** Optional for older hosts; admission stays with the signed person's server. */
    continueTask?(
      request: ConsoleTaskContinuationRequest
    ): Promise<ConsoleWorkflowResult<ConsoleLocalExecutionView>>
  }
