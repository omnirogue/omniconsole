/**
 * Whether a step that only pauses ads may go without the person, for one conversation: its own
 * choice (kept with its Keep going state), else the global setting, else allowed.
 */

import { conversationSourceRowKey } from '../../shared/conversation-source'
import { resolveAdPauses, type NextStepAdPauses } from '../../shared/next-step-ad-pauses'
import { normalizeNextStepSuggestionSettings } from '../../shared/next-step-suggestion-settings'
import {
  getNextStepKeepGoingController,
  getNextStepSuggestionService
} from './next-step-suggestion-slot'

/** Where the step would go; absent (or no pane yet) = only the global setting applies. */
export type AdPauseTarget = { worktreeId: string; paneKey: string | null }

export function adPausesFor(target?: AdPauseTarget): NextStepAdPauses {
  const service = getNextStepSuggestionService()
  const global = service
    ? normalizeNextStepSuggestionSettings(service.deps.settings()).adPauses
    : undefined
  const session =
    target?.paneKey
      ? getNextStepKeepGoingController()?.deps.store.get(
          conversationSourceRowKey({ worktreeId: target.worktreeId, paneKey: target.paneKey })
        )?.adPauses
      : undefined
  return resolveAdPauses(global, session)
}
