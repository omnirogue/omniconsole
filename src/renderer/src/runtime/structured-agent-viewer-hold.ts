import { STRUCTURED_AGENT_SESSION_VIEWER_HOLD_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import {
  runtimeEnvironmentSupportsCapability,
  type RuntimeClientTarget
} from './runtime-rpc-client'
import { getStructuredAgentSessionStatusFeed } from './structured-agent-session-status-feed'
import { callStructuredAgentSession } from './structured-agent-session-client'

export type StructuredViewerHoldResult = {
  processState: 'live' | 'exited' | 'unverifiable'
  fallback: boolean
}

export async function acquireStructuredViewerHold(
  target: RuntimeClientTarget,
  sessionId: string,
  holderId: string,
  active: () => boolean
): Promise<StructuredViewerHoldResult | null> {
  const supported =
    target.kind === 'local' ||
    (await runtimeEnvironmentSupportsCapability(
      target.environmentId,
      STRUCTURED_AGENT_SESSION_VIEWER_HOLD_RUNTIME_CAPABILITY
    ))
  if (!active()) {
    return null
  }
  const result = await callStructuredAgentSession<{ held: true; processState?: unknown }>(
    target,
    'agentSession.hold',
    { sessionId, holderId, ...(supported ? { mode: 'viewer' } : {}) }
  )
  if (!supported) {
    return { processState: 'unverifiable', fallback: true }
  }
  if (
    result?.held !== true ||
    (result.processState !== 'live' &&
      result.processState !== 'exited' &&
      result.processState !== 'unverifiable')
  ) {
    throw new Error('The host did not confirm the viewer hold.')
  }
  return { processState: result.processState, fallback: false }
}

// Subscribe after the hold readback; cached summaries cannot override that newer proof.
export function observeStructuredViewerProcess(
  target: RuntimeClientTarget,
  sessionId: string,
  onChange: (state: StructuredViewerHoldResult['processState']) => void
): () => void {
  const owner = getStructuredAgentSessionStatusFeed(target)
  let previous = owner.getSnapshot().get(sessionId)
  let revision = owner.getExecutionRevision()
  const unsubscribe = owner.subscribe(() => {
    const summary = owner.getSnapshot().get(sessionId)
    const nextRevision = owner.getExecutionRevision()
    if (summary === previous && revision === nextRevision) {
      return
    }
    revision = nextRevision
    previous = summary
    onChange(summary?.processState ?? 'unverifiable')
  })
  const deactivate = owner.activate()
  return () => {
    unsubscribe()
    deactivate()
  }
}
