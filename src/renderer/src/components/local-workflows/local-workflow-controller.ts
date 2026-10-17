import type {
  LocalWorkflowDraft,
  LocalWorkflowScopeOption
} from '../../../../shared/local-workflow-draft'
import type {
  LocalWorkflowSeatCatalog,
  LocalWorkflowSeatChoice
} from '../../../../shared/local-workflow-seats'
import type { LocalWorkflowAction, LocalWorkflowView } from '../../../../shared/local-workflow-view'
import type {
  LocalWorkflowReadCallResult,
  LocalWorkflowSaveResult
} from '../../../../shared/local-workflow-rpc'

/** Supplied by the host projection hook; neither presentation mounts nor view changes launch. */
export type LocalWorkflowController = {
  catalog: readonly LocalWorkflowSeatCatalog[]
  defaults?: LocalWorkflowDraft
  /** Workflow graphs: the seat each available model family uses. */
  graphTeam: readonly LocalWorkflowSeatChoice[]
  scopeLabel: string
  scopeOptions: readonly LocalWorkflowScopeOption[]
  maxConcurrency: number
  auditSupport?: { version: 1; unavailableReason?: string }
  auditTeam?: readonly LocalWorkflowSeatChoice[]
  unavailableReason?: string
  loading?: boolean
  error?: string
  view?: LocalWorkflowView
  start: (draft: LocalWorkflowDraft) => Promise<{ executionId: string }>
  control?: (executionId: string, fence: number, action: LocalWorkflowAction) => Promise<void>
  /** Loads one call's captured logs on demand (pushed views omit them). */
  readCall?: (executionId: string, callId: string) => Promise<LocalWorkflowReadCallResult>
  followUp?: (
    executionId: string,
    prompt: string,
    savedResult?: Extract<LocalWorkflowSaveResult, { saved: true }>
  ) => Promise<void>
  newTurn?: (executionId: string) => Promise<void>
}
