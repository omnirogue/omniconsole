import type {
  SessionOutcomeCurrentInputFile,
  SessionOutcomeCurrentInput,
  SessionOutcomeCurrentSnapshot
} from '../../shared/session-outcome-current-inputs'
import type { OutcomeAmendmentCancellationPort } from '../../shared/outcome-amendment-cancellation'
import type {
  ConsoleWorkflowJob,
  ConsoleWorkflowAdmission,
  ConsoleWorkflowProgress,
  ConsoleWorkflowResult,
  ConsoleWorkflowStep
} from '../../shared/console-workflow-types'
import type {
  SessionOutcomeWorkflow,
  SessionOutcomeCanonicalSeal,
  SessionOutcomeStageReceipt,
  SessionOutcomeWorkflowPreview
} from '../../shared/session-outcome-workflow'
import type {
  ConsoleLocalExecutionView,
  ConsoleLocalStartRequest
} from '../../shared/console-local-execution'
import type { OrcaRuntimeService } from './omni-runtime'

export type SessionOutcomeWorkflowPort = {
  captureSourceInputs?(
    runtime: OrcaRuntimeService,
    input: {
      taskId: string
      worktree: string
      principal: string
      selectedSourcePaths: string[]
      sourceResult: { path: string; content: string }
    }
  ): Promise<SessionOutcomeCurrentSnapshot>
  captureCurrentInputs?(
    runtime: OrcaRuntimeService,
    input: { taskId: string; worktree: string; principal: string; selectedSourcePaths: string[] }
  ): Promise<SessionOutcomeCurrentInputFile[]>

  cancellation(
    runtime: OrcaRuntimeService,
    workflows: SessionOutcomeWorkflow[],
    principal: string
  ): OutcomeAmendmentCancellationPort
  preview(
    runtime: OrcaRuntimeService,
    input: {
      taskId: string
      operationId: string
      worktree: string
      principal: string
      stages: ConsoleWorkflowStep[]
      currentInputs?: SessionOutcomeCurrentInput[]
      predecessorReceipts?: SessionOutcomeWorkflow['predecessorReceipts']
    }
  ): Promise<SessionOutcomeWorkflowPreview>
  admit(
    preview: SessionOutcomeWorkflowPreview,
    principal: string
  ): Promise<ConsoleWorkflowResult<ConsoleWorkflowAdmission>>
  observe(
    workflowId: string,
    principal: string
  ): Promise<ConsoleWorkflowResult<ConsoleWorkflowProgress>>
  start(
    runtime: OrcaRuntimeService,
    request: ConsoleLocalStartRequest
  ): Promise<ConsoleWorkflowResult<ConsoleLocalExecutionView>>
  receipt(
    runtime: OrcaRuntimeService,
    job: ConsoleWorkflowJob,
    activation: SessionOutcomeWorkflow['activations'][number],
    principal: string,
    seal: SessionOutcomeCanonicalSeal
  ): Promise<SessionOutcomeStageReceipt | null>
  list(runtime: OrcaRuntimeService): Promise<ConsoleWorkflowResult<ConsoleLocalExecutionView[]>>
}
let port: SessionOutcomeWorkflowPort | null = null
export function installSessionOutcomeWorkflowPort(value: SessionOutcomeWorkflowPort): void {
  port = value
}
export function sessionOutcomeWorkflowPort(): SessionOutcomeWorkflowPort {
  if (!port) {
    throw new Error('The admitted outcome-plan adapter is unavailable on this host.')
  }
  return port
}
