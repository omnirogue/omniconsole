import { CONVERSATION_PERSON_HANDOFF_ACTOR } from './console-conversation-person-handoff'
import type { ConsoleWorkflowGraph } from './console-workflow-types'

/** A delivery task records sending; it must never adopt the source outcome. */
export function matchesConversationFleetAdoption(
  graph: ConsoleWorkflowGraph,
  adoptStage: string | null
): boolean {
  return adoptStage === null
    ? graph.nodes.every(
        (node) =>
          node.actor_type === 'mechanical' &&
          node.actor_id === CONVERSATION_PERSON_HANDOFF_ACTOR &&
          node.action === 'notify'
      )
    : graph.nodes.some((node) => node.key === adoptStage && node.actor_type === 'ai')
}
