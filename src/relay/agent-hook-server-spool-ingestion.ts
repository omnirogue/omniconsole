import { prepareCodexHookTranscript } from '../shared/agent-hook-codex-transcript-preparation'
import { normalizeHookPayload } from '../shared/agent-hook-listener'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { HookListenerState } from '../shared/agent-hook-listener/listener-state'
import { isAgentHookSource, type AgentHookSource } from '../shared/agent-hook-relay'
import { buildSpoolHookBody, type SpoolRecord } from '../shared/agent-hook-spool'
import { hookBodyEnv, hookBodyVersion } from './agent-hook-envelope-build'

export type SpoolIngestionDeps = {
  state: HookListenerState
  env: string
  applyEvent: (
    event: AgentHookEventPayload,
    source: AgentHookSource,
    env?: string,
    version?: string,
    options?: { isReplay?: boolean; rawBody?: unknown }
  ) => boolean
}

/** Replays one persisted spool record through the same normalize/apply path a live POST takes,
 *  marked `isReplay` so downstream clients treat it as a resend rather than a fresh event. */
export async function ingestAgentHookSpoolRecord(
  deps: SpoolIngestionDeps,
  record: SpoolRecord
): Promise<void> {
  if (!isAgentHookSource(record.source)) {
    return
  }
  const body = buildSpoolHookBody(record)
  await prepareCodexHookTranscript(deps.state, record.source, body, deps.env)
  const event = normalizeHookPayload(deps.state, record.source, body, deps.env, {
    deferCompactOwnershipToClient: true
  })
  if (!event) {
    return
  }
  deps.applyEvent(event, record.source, hookBodyEnv(body), hookBodyVersion(body), {
    isReplay: record.isReplay !== false
  })
}
