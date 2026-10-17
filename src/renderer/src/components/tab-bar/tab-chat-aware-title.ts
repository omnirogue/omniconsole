import { formatAgentTypeLabel } from '../../../../shared/agent-type-label'
import { resolveTabDisplayTitle } from '../../../../shared/tab-chat-display-title'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { fallbackConversationTitle, isPlaceholderConversationTitle } from '@/lib/conversation-state'

/**
 * SortableTab's renderer-side wiring for `resolveTabDisplayTitle`: it supplies the two
 * existing helpers (placeholder test + neutral fallback) the shared decision needs,
 * since those live in renderer/lib and can't be imported from src/shared itself.
 */
export function resolveChatAwareTabTitle(
  resolvedTitle: string,
  viewMode: 'terminal' | 'chat' | undefined,
  agent: TuiAgent | null
): string {
  return resolveTabDisplayTitle({
    resolvedTitle,
    viewMode,
    isPlaceholderTitle: isPlaceholderConversationTitle(resolvedTitle),
    chatFallbackTitle: fallbackConversationTitle(formatAgentTypeLabel(agent))
  })
}
