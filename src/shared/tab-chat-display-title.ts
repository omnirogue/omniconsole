// Why: a chat-mode tab must never show the terminal-creation placeholder
// ("Terminal 3") in the tab strip — Sal's complaint. This is display-only: it
// does not change what gets STORED as the tab's title/label, only what a
// chat-mode tab renders when the already-resolved title is still that
// placeholder.
//
// Why the placeholder test and fallback text are passed in rather than computed
// here: they already exist as `isPlaceholderConversationTitle` /
// `fallbackConversationTitle` in renderer/src/lib/conversation-state.ts (so this
// stays one naming rule, not two), but that module pulls in renderer-only paths
// (`@/i18n/i18n`, `@/components/AgentStateDot`) that the non-renderer tsconfig
// projects covering src/shared can't resolve. Callers (renderer-only) compute
// both and hand them to this pure decision.

/**
 * The title a tab should actually render, given the title already resolved by
 * `resolveTerminalTabTitle` / `resolveUnifiedTabLabel`.
 *
 * - Plain terminal tabs (`viewMode !== 'chat'`) are returned unchanged.
 * - Chat tabs whose resolved title is still a placeholder (or empty — the
 *   caller's `isPlaceholderTitle` covers both) show `chatFallbackTitle`
 *   instead — `resolveUnifiedTabLabel` already prefers the generated title
 *   over the placeholder when one exists, so reaching this branch means there
 *   isn't one yet.
 */
export function resolveTabDisplayTitle({
  resolvedTitle,
  viewMode,
  isPlaceholderTitle,
  chatFallbackTitle
}: {
  resolvedTitle: string
  viewMode: 'terminal' | 'chat' | undefined
  isPlaceholderTitle: boolean
  chatFallbackTitle: string
}): string {
  if (viewMode !== 'chat' || !isPlaceholderTitle) {
    return resolvedTitle
  }
  return chatFallbackTitle
}
