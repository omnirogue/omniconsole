import {
  agentProviderSessionsEqual,
  type AgentProviderSessionMetadata
} from '../../../../shared/agent-session-resume'
import type { AgentConversationIdentity } from '../../../../shared/agent-status-observation'
import type {
  AgentStatusEntry,
  AgentStatusState,
  AgentType
} from '../../../../shared/agent-status-types'

type IdentityEvidence = Pick<
  AgentStatusEntry,
  'agentType' | 'providerSession' | 'conversationIdentity' | 'terminalHandle' | 'state'
>

function identityOf(entry: IdentityEvidence | undefined): AgentConversationIdentity | undefined {
  if (entry?.conversationIdentity) {
    return entry.conversationIdentity
  }
  return entry?.agentType && entry.providerSession
    ? {
        agentType: entry.agentType,
        providerSession: entry.providerSession,
        ...(entry.terminalHandle ? { terminalHandle: entry.terminalHandle } : {})
      }
    : undefined
}

export function agentConversationIdentitiesEqual(
  left: AgentConversationIdentity | undefined,
  right: AgentConversationIdentity | undefined
): boolean {
  if (left === undefined || right === undefined) {
    return left === right
  }
  return (
    left.agentType === right.agentType &&
    left.terminalHandle === right.terminalHandle &&
    left.agentPid === right.agentPid &&
    agentProviderSessionsEqual(left.agentType, left.providerSession, right.providerSession)
  )
}

type IncarnationEvidence = {
  existing: IdentityEvidence
  previous: AgentConversationIdentity
  incomingState: AgentStatusState
  sessionBoundary: boolean
  routedTerminalHandle: string | undefined
  agentPid: number | undefined
}

/**
 * Whether this write positively comes from the process the identity was observed in. Another
 * terminal or another agent process contradicts it. A new start — a turn begun after a finished
 * one, or a session boundary — needs the same agent process (its pid) to continue the identity:
 * a reused pane can run a new agent whose finished predecessor's row was never cleared.
 */
function sameIncarnation(evidence: IncarnationEvidence): boolean {
  const { previous, routedTerminalHandle, agentPid } = evidence
  if (
    (routedTerminalHandle !== undefined &&
      previous.terminalHandle !== undefined &&
      routedTerminalHandle !== previous.terminalHandle) ||
    (agentPid !== undefined && previous.agentPid !== undefined && agentPid !== previous.agentPid)
  ) {
    return false
  }
  const sameProcess = agentPid !== undefined && previous.agentPid === agentPid
  const newStart =
    evidence.sessionBoundary ||
    (evidence.existing.state === 'done' && evidence.incomingState !== 'done')
  if (newStart) {
    return sameProcess
  }
  const sameTerminal =
    previous.terminalHandle !== undefined &&
    (routedTerminalHandle === undefined || routedTerminalHandle === previous.terminalHandle)
  return sameProcess || sameTerminal
}

/**
 * The conversation a live status row belongs to after one status write (C5).
 *
 * Why separate from `providerSession`: that field is exact-resume metadata, and a metadata-less
 * `done → working` drops it so a reused pane can never resume a finished session. Keying the
 * sidebar's conversation identity on it too made one unchanged conversation split from its
 * other panes and leave Archived on every such turn, then merge back when metadata returned.
 *
 * The identity therefore follows the agent process incarnation: replaced the moment a different
 * session is positively identified; kept while the same process keeps reporting (its pid, or —
 * within one turn — its terminal); never inherited across a new start without proof of the same
 * process; dropped when the agent kind, terminal or process changes. A row with no live entry
 * (the pane was torn down) starts again from what the next report proves.
 */
export function resolveAgentConversationIdentity(args: {
  existing: IdentityEvidence | undefined
  agentType: AgentType | undefined
  /** The resume metadata this write keeps: reported now, or carried within the turn. */
  providerSession: AgentProviderSessionMetadata | undefined
  incomingState: AgentStatusState
  /** This `done` marks a session boundary (a connect, resume or clear landing idle). */
  sessionBoundary: boolean
  /** The terminal handle the hook routed this write with, when it carried one. */
  routedTerminalHandle: string | undefined
  /** The terminal handle the row holds after this write. */
  terminalHandle: string | undefined
  /** The local agent process that sent this report, when the hook named it. */
  agentPid: number | undefined
}): AgentConversationIdentity | undefined {
  const { agentType, providerSession, existing } = args
  if (!agentType) {
    return undefined
  }
  const previous = identityOf(existing)
  if (providerSession) {
    const continues =
      previous !== undefined &&
      previous.agentType === agentType &&
      agentProviderSessionsEqual(agentType, previous.providerSession, providerSession)
    const agentPid = args.agentPid ?? (continues ? previous.agentPid : undefined)
    const next: AgentConversationIdentity = {
      agentType,
      providerSession,
      ...(args.terminalHandle ? { terminalHandle: args.terminalHandle } : {}),
      ...(agentPid !== undefined ? { agentPid } : {})
    }
    // Why the previous object: an unchanged identity keeps its reference for row sharing.
    return continues && agentConversationIdentitiesEqual(previous, next) ? previous : next
  }
  if (!existing || !previous || previous.agentType !== agentType) {
    return undefined
  }
  if (!sameIncarnation({ ...args, existing, previous })) {
    return undefined
  }
  // Why: the process now proven adds its pid, so a later new start can be told apart.
  return previous.agentPid === undefined && args.agentPid !== undefined
    ? { ...previous, agentPid: args.agentPid }
    : previous
}
