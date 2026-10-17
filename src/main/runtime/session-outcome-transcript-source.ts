import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import {
  sessionFollowUpTranscriptSource,
  type SessionFollowUpTranscriptSource
} from '../../shared/session-follow-up-transcript'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import type { StructuredAgentSessionTab } from '../native-chat/agent-session-wire/structured-agent-session-host-tabs'

export function providerSessionOutcomeTranscriptSource(
  rows: readonly AgentStatusIpcPayload[],
  paneKey: string,
  worktreeId: string
): SessionFollowUpTranscriptSource | undefined {
  const identities = new Map<string, SessionFollowUpTranscriptSource>()
  for (const row of rows) {
    if (
      row.paneKey !== paneKey ||
      row.worktreeId !== worktreeId ||
      row.connectionId !== null ||
      !row.agentType ||
      !row.providerSession
    ) {
      continue
    }
    const source = sessionFollowUpTranscriptSource.safeParse({
      kind: 'provider',
      hostId: 'local',
      agent: row.agentType,
      sessionId: row.providerSession.id,
      ...(row.providerSession.transcriptPath
        ? { transcriptPath: row.providerSession.transcriptPath }
        : {})
    })
    if (source.success) {
      identities.set(JSON.stringify([row.providerSession.key, source.data]), source.data)
    }
  }
  return identities.size === 1 ? identities.values().next().value : undefined
}

export function structuredSessionOutcomeTranscriptSource(
  sessions: readonly StructuredAgentSessionTab[],
  paneKey: string,
  worktreeId: string
): SessionFollowUpTranscriptSource | undefined {
  const matches = sessions.filter(
    (session) =>
      session.workspaceId === worktreeId &&
      structuredAgentSessionPaneKey(
        structuredAgentSessionTabId(session.sessionId),
        session.sessionId
      ) === paneKey
  )
  if (matches.length !== 1) {
    return undefined
  }
  const source = sessionFollowUpTranscriptSource.safeParse({
    kind: 'structured',
    hostId: 'local',
    agent: matches[0]!.agent,
    sessionId: matches[0]!.sessionId
  })
  return source.success ? source.data : undefined
}
