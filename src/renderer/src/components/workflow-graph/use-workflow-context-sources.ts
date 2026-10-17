import { useState } from 'react'
import { translate } from '@/i18n/i18n'
import type { LocalWorkflowDraft } from '../../../../shared/local-workflow-draft'
import {
  workflowContextPrefill,
  workflowContextSourcesIn
} from '../../../../shared/workflow-context-detect'
import {
  workflowContextRemoveSource,
  workflowContextSourceKey,
  type WorkflowContextSource
} from '../../../../shared/workflow-context-sources'
import {
  workflowContextChoice,
  workflowContextDraftForStart
} from '../../../../shared/workflow-context-start'

/**
 * The sources a task names, offered once the person stops typing and never again once removed,
 * and the draft a Start sends. Only "Find it from my description" reads sources from the task.
 */
export function useWorkflowContextSources() {
  // Keys of sources the person removed: the task never offers them again.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set())
  const detected = (draft: LocalWorkflowDraft) =>
    workflowContextChoice(draft) === 'auto'
      ? workflowContextSourcesIn(draft.prompt).filter(
          (source) => !dismissed.has(workflowContextSourceKey(source))
        )
      : []
  return {
    /** The sources to add for what the task names now, or undefined when nothing is new. */
    prefill: (draft: LocalWorkflowDraft): WorkflowContextSource[] | undefined =>
      workflowContextChoice(draft) === 'auto'
        ? workflowContextPrefill(draft.prompt, draft.contextSources ?? [], dismissed)
        : undefined,
    remove: (draft: LocalWorkflowDraft, source: WorkflowContextSource): LocalWorkflowDraft => {
      setDismissed(new Set([...dismissed, workflowContextSourceKey(source)]))
      return {
        ...draft,
        contextSources: workflowContextRemoveSource(draft.contextSources ?? [], source)
      }
    },
    /** The draft to send, or a refusal when nothing at all was left for the agents to read. */
    forStart: (draft: LocalWorkflowDraft): LocalWorkflowDraft => {
      const prepared = workflowContextDraftForStart(draft, detected(draft))
      if ('error' in prepared) {
        throw new Error(
          translate(
            'workflowGraph.context.nothingChosen',
            'Choose at least one file, folder or repo, or choose "Find it from my description".'
          )
        )
      }
      return prepared.draft
    }
  }
}
