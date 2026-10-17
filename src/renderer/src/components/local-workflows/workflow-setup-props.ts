import type {
  LocalWorkflowDraft,
  LocalWorkflowScopeOption
} from '../../../../shared/local-workflow-draft'
import type { LocalWorkflowSeatCatalog } from '../../../../shared/local-workflow-seats'

/** Shared by the Council and Discover setups; LocalWorkflowSetup picks one by preset. */
export type WorkflowSetupProps = {
  draft: LocalWorkflowDraft
  catalog: readonly LocalWorkflowSeatCatalog[]
  scopeOptions: readonly LocalWorkflowScopeOption[]
  maxConcurrency: number
  unavailableReason?: string
  /** An earlier Start is unresolved: the draft is frozen and Start retries it unchanged. */
  recoveringStart?: boolean
  onChange: (draft: LocalWorkflowDraft) => void
  onStart: (draft: LocalWorkflowDraft) => Promise<void>
}

/**
 * The setup no longer offers an output filename. One carried over from an older draft (or a "New
 * question" copy of one) would still make the host write a file the person never saw, so it goes.
 */
export function withoutHiddenOutputFile(draft: LocalWorkflowDraft): LocalWorkflowDraft {
  if (draft.outputFileName === undefined) {
    return draft
  }
  const next = { ...draft }
  delete next.outputFileName
  return next
}
