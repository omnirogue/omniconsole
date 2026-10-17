import type { CodexStructuredLaunch } from './codex-structured-session-state'
import { CODEX_SPAWN_TOKEN_ENV } from './codex-structured-owner-identity'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { structuredSessionOutcomeEnvironment } from '../native-chat/agent-session-wire/structured-agent-session-outcome-environment'

export function buildCodexStructuredChildEnvironment(
  launch: CodexStructuredLaunch,
  spawnToken: string,
  identity?: AgentSessionJournalIdentity
): Record<string, string> {
  return {
    ...launch.env,
    ...(launch.codexHome ? { CODEX_HOME: launch.codexHome } : {}),
    ...(identity ? structuredSessionOutcomeEnvironment(identity) : {}),
    [CODEX_SPAWN_TOKEN_ENV]: spawnToken
  }
}
