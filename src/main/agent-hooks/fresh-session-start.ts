import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'

function carriesNothing(event: AgentHookEventPayload): boolean {
  return (
    !event.hasExplicitPrompt &&
    !event.isReplay &&
    !event.restoredUnconfirmed &&
    !event.payload.prompt &&
    !event.payload.interactivePrompt &&
    !event.payload.lastAssistantMessage
  )
}

function isStartupSessionStart(event: AgentHookEventPayload): boolean {
  return (
    event.hookEventName?.replaceAll('_', '').toLowerCase() === 'sessionstart' &&
    event.sessionStartSource === 'startup' &&
    carriesNothing(event)
  )
}

/**
 * The empty announcement a new, non-resumed Claude or Codex makes before anyone has asked it
 * anything. Why those two only: the transfer watcher's proof was built on them; the steward reads
 * the other agents through `isBlankFreshStart`.
 */
export function isUntouchedFreshStart(event: AgentHookEventPayload): boolean {
  return (
    (event.source === undefined || event.source === 'claude' || event.source === 'codex') &&
    isStartupSessionStart(event)
  )
}

/**
 * Any agent's own announcement that it started fresh with nothing asked: a startup SessionStart
 * (Claude, Codex, Gemini), or OpenCode's SessionStart, which its plugin sends only when a root
 * session is created (`status-plugin-factory-source.ts`), never for a resumed one. Kimi, OMP, Pi,
 * Grok, Droid, Devin and the rest send no start that tells new from resumed, so they never read
 * untouched.
 */
export function isBlankFreshStart(event: AgentHookEventPayload): boolean {
  if (isStartupSessionStart(event)) {
    return event.source === undefined || ['claude', 'codex', 'gemini'].includes(event.source)
  }
  return (
    event.source === 'opencode' &&
    event.hookEventName === 'SessionStart' &&
    event.providerSessionOnly !== true &&
    carriesNothing(event)
  )
}
