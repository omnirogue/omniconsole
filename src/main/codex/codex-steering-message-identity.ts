import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'

const STEERING_CLIENT_PREFIX = 'omni-steer:'

/** Codex persists clientId, so live steering and resumed history share one receipt identity. */
export function codexSteeringClientId(clientMessageId: string): string {
  return `${STEERING_CLIENT_PREFIX}${clientMessageId}`
}

export function codexSteeringMessageIdentity(clientId: unknown): AgentJournalItemIdentity | null {
  return typeof clientId === 'string' &&
    clientId.startsWith(STEERING_CLIENT_PREFIX) &&
    clientId.length > STEERING_CLIENT_PREFIX.length
    ? { provider: 'omni', clientMessageId: clientId.slice(STEERING_CLIENT_PREFIX.length) }
    : null
}
