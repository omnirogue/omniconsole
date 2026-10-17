import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import type { NextStepSuggestionSet } from '../../shared/next-step-suggestions'
import type { NextStepsListResult } from '../../shared/next-step-suggestions-rpc'
import type { NextStepSuggestionService } from './next-step-suggestion-service'

export type NextStepListFilter = {
  worktreeId?: string
  conversation?: ConversationSource
  statuses?: readonly NextStepSuggestionSet['status'][]
}

/** The sets and skips a client may see, narrowed by workspace, conversation and status. */
export function listNextStepSets(
  service: NextStepSuggestionService,
  filter: NextStepListFilter
): NextStepsListResult {
  const key = filter.conversation ? conversationSourceRowKey(filter.conversation) : null
  const matches = (conversation: ConversationSource | undefined, worktreeId?: string): boolean =>
    (!key || (conversation !== undefined && conversationSourceRowKey(conversation) === key)) &&
    (!filter.worktreeId || (worktreeId ?? conversation?.worktreeId) === filter.worktreeId)
  const { storageError } = service.deps.store
  return {
    sets: service.deps.store
      .list()
      .filter(
        (set) =>
          matches(set.conversation, set.worktreeId) &&
          (!filter.statuses || filter.statuses.includes(set.status))
      ),
    skips: service.skips.filter((skip) => matches(skip.conversation)).toReversed(),
    revision: service.revision,
    ...(storageError ? { storageError } : {})
  }
}
