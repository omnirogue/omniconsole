import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { AGENT_SESSION_NOT_ATTACHED } from './structured-agent-session-mutation-admission'

export function requireAttachedStructuredSession(
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>,
  sessionId: string
): StructuredAgentSessionHostSession {
  const session = sessions.get(sessionId)
  if (!session) {
    throw new Error(AGENT_SESSION_NOT_ATTACHED.code)
  }
  return session
}
