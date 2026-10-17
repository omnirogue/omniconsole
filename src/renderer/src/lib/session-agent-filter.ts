import type { TuiAgent } from '../../../shared/tui-agent'
import { conversationViewKey } from './conversation-view'
import type { SidebarSession } from './sidebar-sessions'

/** The agents the Conversations toolbar offers as one-click filters, in display order. */
export const SESSION_AGENT_FILTER_IDS = [
  'claude',
  'codex',
  'grok',
  'kimi',
  'gemini',
  'omp'
] as const satisfies readonly TuiAgent[]

export type SessionAgentFilterId = (typeof SESSION_AGENT_FILTER_IDS)[number]

export function isSessionAgentFilterId(value: unknown): value is SessionAgentFilterId {
  return (SESSION_AGENT_FILTER_IDS as readonly unknown[]).includes(value)
}

/** Which filter button a session answers to; agent teams are still Claude. */
export function sessionAgentFilterId(agent: string): SessionAgentFilterId | null {
  if (agent === 'claude-agent-teams') {
    return 'claude'
  }
  return isSessionAgentFilterId(agent) ? agent : null
}

/**
 * The sessions of one agent that are not archived; with no filter, every session passes
 * untouched (archive display stays the list's own decision).
 */
export function filterSessionsByAgent<T extends SidebarSession>(
  sessions: readonly T[],
  filter: SessionAgentFilterId | null,
  archivedKeys: ReadonlySet<string>
): readonly T[] {
  if (filter === null) {
    return sessions
  }
  return sessions.filter(
    (session) =>
      sessionAgentFilterId(session.agent) === filter &&
      !archivedKeys.has(conversationViewKey(session))
  )
}
