import { conversationSourceRowKey } from '../../shared/conversation-source'
import { nextStepReplyDecision } from '../../shared/next-step-reply-decision'
import type { NextStepSuggestionSet } from '../../shared/next-step-suggestions'
import type { NextStepReplyDecision } from '../../shared/next-step-suggestions-rpc'
import type { NextStepSuggestionService } from './next-step-suggestion-service'
import {
  currentNextSteps,
  nextStepsFromReply,
  nextStepTurnHasAnswer
} from './next-step-turn-answers'
import type { NextStepListFilter } from './next-step-set-listing'
import { getNextStepKeepGoingController } from './next-step-suggestion-slot'
import type { FinishedTurn } from './next-step-turn-signal'
import { promptQueuePending } from '../../shared/prompt-queue-types'
import { matchesNextStepReplyPtyProof } from '../../shared/next-step-reply-proof'

function repairMalformedChoiceSet(
  service: NextStepSuggestionService,
  set: NextStepSuggestionSet,
  turn: FinishedTurn
): NextStepSuggestionSet {
  const controller = getNextStepKeepGoingController()
  if (
    !controller ||
    controller.list({ conversation: turn.conversation }).some((state) => state.enabled) ||
    set.origin !== 'parsed' ||
    set.status !== 'pending' ||
    set.turnKey !== turn.turnKey ||
    !set.conversation ||
    conversationSourceRowKey(set.conversation) !== conversationSourceRowKey(turn.conversation) ||
    set.suggestions.length !== 1 ||
    !/^Recommended\.?$/i.test(set.suggestions[0]!.title.trim()) ||
    nextStepTurnHasAnswer(service, turn)
  ) {
    return set
  }
  const choices = nextStepsFromReply(turn.lastAssistantMessage)
  if (choices.length < 2 || choices.some((choice) => !choice.optionGroup)) {
    return set
  }
  const currentSources = service.deps.listReplyDecisionSources?.()
  const key = conversationSourceRowKey(turn.conversation)
  const queue = service.deps.readPromptQueue(turn.conversation)
  if (
    (currentSources &&
      !currentSources.some((source) => conversationSourceRowKey(source) === key)) ||
    (queue && promptQueuePending(queue).length > 0)
  ) {
    return set
  }
  // A stale click must refuse, never gain different options behind the same set id.
  service.deps.store.update(set.id, (current) => ({
    ...current,
    status: 'superseded',
    error: 'The current reply menu was re-read; use its updated choices.'
  }))
  const replacement = service.newSet(turn, 'parsed', 'pending', choices)
  return service.deps.store.upsert({
    ...replacement,
    createdAt: Math.max(replacement.createdAt, set.createdAt + 1)
  })
}

/** Reuse the owner turn authority; stored pending suggestions alone never establish a question. */
export async function currentReplyDecisions(
  service: NextStepSuggestionService,
  sets: readonly NextStepSuggestionSet[],
  filter: NextStepListFilter = {}
): Promise<NextStepReplyDecision[]> {
  const sources = new Map(
    sets.flatMap((set) =>
      set.origin === 'parsed' && set.status === 'pending' && set.conversation
        ? [[conversationSourceRowKey(set.conversation), set.conversation] as const]
        : []
    )
  )
  const observedSources = service.deps.listReplyDecisionSources?.()
  const observedKeys = observedSources && new Set(observedSources.map(conversationSourceRowKey))
  for (const source of observedSources ?? []) {
    const key = conversationSourceRowKey(source)
    if (
      (!filter.worktreeId || source.worktreeId === filter.worktreeId) &&
      (!filter.conversation || key === conversationSourceRowKey(filter.conversation))
    ) {
      sources.set(key, source)
    }
  }
  const decisions: { decision: NextStepReplyDecision; setId: string }[] = []
  for (const [key, conversation] of sources) {
    if (observedKeys && !observedKeys.has(key)) {
      continue
    }
    const queue = service.deps.readPromptQueue(conversation)
    if (queue && promptQueuePending(queue).length > 0) {
      continue
    }
    const ptyProof =
      conversation.kind === 'pty'
        ? service.deps.readReplyDecisionPtyProof?.(conversation)
        : undefined
    const current = await currentNextSteps(service, conversation)
    let parsed = current.parsed
    const turn = service.currentTurns.get(key)?.turn
    if (
      !parsed ||
      parsed.status !== 'pending' ||
      current.answered ||
      current.turnObserved !== true ||
      parsed.turnKey !== current.turnKey ||
      turn?.turnKey !== current.turnKey ||
      !turn.replyComplete ||
      (conversation.kind === 'pty' &&
        (!ptyProof ||
          ptyProof.turnKey !== turn.turnKey ||
          JSON.stringify(service.deps.readReplyDecisionPtyProof?.(conversation)) !==
            JSON.stringify(ptyProof) ||
          !matchesNextStepReplyPtyProof(ptyProof, {
            providerSession: ptyProof.providerSession,
            lastAssistantMessage: turn.lastAssistantMessage
          }))) ||
      typeof turn.completedAt !== 'number' ||
      !Number.isFinite(turn.completedAt)
    ) {
      continue
    }
    const question = nextStepReplyDecision(turn.lastAssistantMessage)
    if (question) {
      parsed = repairMalformedChoiceSet(service, parsed, turn)
      decisions.push({
        setId: parsed.id,
        decision: {
          conversation,
          turnKey: turn.turnKey,
          completedAt: turn.completedAt,
          question,
          ...(ptyProof ? { ptyProof } : {})
        }
      })
    }
  }
  const latestSources = service.deps.listReplyDecisionSources?.()
  const latestKeys = latestSources && new Set(latestSources.map(conversationSourceRowKey))
  return decisions.flatMap(({ decision, setId }) => {
    const key = conversationSourceRowKey(decision.conversation)
    const current = service.currentTurns.get(key)
    const set = service.deps.store.get(setId)
    const queue = service.deps.readPromptQueue(decision.conversation)
    const currentProof =
      decision.conversation.kind === 'pty'
        ? service.deps.readReplyDecisionPtyProof?.(decision.conversation)
        : undefined
    return current?.turnKey === decision.turnKey &&
      set?.status === 'pending' &&
      (!latestKeys || latestKeys.has(key)) &&
      (decision.conversation.kind !== 'pty' ||
        (currentProof && JSON.stringify(currentProof) === JSON.stringify(decision.ptyProof))) &&
      (!queue || promptQueuePending(queue).length === 0)
      ? [decision]
      : []
  })
}
