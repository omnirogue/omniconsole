/**
 * The conversation a typed answer was checked against, re-checked by the prompt queue before each
 * guarded write (text and Enter): a pane reused by another conversation in the meantime gets nothing.
 */

import { parseSessionReference, transcriptSessionIdOf } from '../../shared/session-reference'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type { SessionPromptBinding } from '../runtime/session-prompt-binding'

export const WORK_DELIVERY_CONVERSATION_MOVED =
  'The pane no longer runs the conversation this answer is for, so it was not typed.'

export function workDeliveryConversationGuard(
  runtime: Pick<OrcaRuntimeService, 'getReportedProviderSessionsForPane'>,
  paneKey: string,
  ref: string
): Required<Pick<SessionPromptBinding, 'conversationStill' | 'conversationGuard'>> {
  const id = parseSessionReference(ref)?.sessionId.toLowerCase() ?? null
  const still = () => {
    const current = runtime.getReportedProviderSessionsForPane(paneKey)[0]
    return (
      id !== null &&
      current !== undefined &&
      (current.id.toLowerCase() === id ||
        (current.transcriptPath
          ? transcriptSessionIdOf(current.transcriptPath).toLowerCase() === id
          : false))
    )
  }
  return {
    conversationStill: still,
    conversationGuard: async () => (still() ? null : WORK_DELIVERY_CONVERSATION_MOVED)
  }
}
