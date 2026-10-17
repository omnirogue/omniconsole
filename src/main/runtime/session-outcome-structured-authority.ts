import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { RpcContext } from './rpc/core'
import { assertSessionOutcomeIndependentSource } from './session-outcome-source-fence'

export function sessionOutcomeStructuredAuthority(
  context: RpcContext,
  source: { paneKey: string; worktreeId?: string }
) {
  if (!context.orchestrationCompatibilityEvidence?.agentSessionId) {
    return null
  }
  const authority = getStructuredAgentSessionHost()?.outcomeSource.authorize(
    context.orchestrationCompatibilityEvidence
  )
  if (
    !authority ||
    authority.paneKey !== source.paneKey ||
    (source.worktreeId !== undefined && authority.worktreeId !== source.worktreeId)
  ) {
    throw new Error('The outcome caller has no current native source submission authority.')
  }
  assertSessionOutcomeIndependentSource(context.runtime, authority.handle)
  return authority
}
