import { resolveConversationFleetSourceRuntimeEnvironment } from '@/lib/conversation-fleet-context-source'
import { sessionOutcomeConnection } from '@/lib/session-outcome-connection'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { hasRuntimeRpcErrorCode } from '@/runtime/runtime-rpc-client'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { SessionFollowUpRule } from '../../../../shared/session-follow-up-rule'
import { sessionOutcomeTranscriptForHost } from '../../../../shared/session-outcome-routing'

/** A one-shot SSH capture needs its file owner, while queued outcomes still need durable ownership. */
export async function captureImmediateSessionHandoff(
  session: SidebarSession,
  rule: SessionFollowUpRule,
  summary: string
): Promise<SessionFollowUpRule> {
  const host = parseExecutionHostId(session.hostId)
  const common = {
    paneKey: session.paneKey,
    worktreeId: session.worktreeId,
    handoff: rule,
    summary
  }
  if (host?.kind === 'ssh') {
    const environmentId = resolveConversationFleetSourceRuntimeEnvironment(session)
    const target = environmentId
      ? { kind: 'environment' as const, environmentId }
      : { kind: 'local' as const }
    const transcriptSource = rule.transcriptSource
    if (
      transcriptSource &&
      (transcriptSource.hostId !== host.id ||
        (transcriptSource.runtimeEnvironmentId &&
          transcriptSource.runtimeEnvironmentId !== environmentId))
    ) {
      throw new Error('The immediate handoff route does not own the selected transcript.')
    }
    let handoff = rule
    if (transcriptSource) {
      const { runtimeEnvironmentId: _alias, ...ownedSource } = transcriptSource
      handoff = { ...rule, transcriptSource: ownedSource }
    }
    try {
      const result = await sessionOutcomeConnection(target).call<{ handoff: SessionFollowUpRule }>(
        'sessionChain.captureHandoffNow',
        { ...common, handoff, expectedConnectionId: host.targetId },
        { timeoutMs: 60_000 }
      )
      return result.handoff
    } catch (error) {
      if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
        throw new Error('Update the connected OmniConsole runtime to share this SSH session.')
      }
      throw error
    }
  }
  const route = await sessionOutcomeConnection(session).negotiate()
  if (route.capabilities.handoffFolders !== 1) {
    throw new Error('Update the session execution host to hand off the current files.')
  }
  if (rule.transcriptSource && route.capabilities.handoffAttachments !== 1) {
    throw new Error('Update the session execution host to share the full conversation.')
  }
  const ownedRule = rule.transcriptSource
    ? {
        ...rule,
        transcriptSource: sessionOutcomeTranscriptForHost(rule.transcriptSource, route.target)
      }
    : rule
  const result = await route.call<{ handoff: SessionFollowUpRule }>(
    'sessionChain.captureHandoff',
    { ...common, handoff: ownedRule },
    { timeoutMs: 60_000 }
  )
  return result.handoff
}
