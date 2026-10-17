import { prepareCodexHookTranscript } from '../shared/agent-hook-codex-transcript-preparation'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { HOOK_REQUEST_SLOWLORIS_MS } from '../shared/agent-hook-listener/listener-limits'
import { normalizeHookPayload } from '../shared/agent-hook-listener'
import { mergeAgentHookRequestHeaders } from '../shared/agent-hook-listener/hook-envelope'
import { hasValidAgentHookToken } from '../shared/agent-hook-listener/header-compatibility'
import { readRequestBody } from '../shared/agent-hook-listener/request-body'
import { resolveHookSource } from '../shared/agent-hook-listener/source-routing'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { HookListenerState } from '../shared/agent-hook-listener/listener-state'
import {
  isHookRequestTruncatedError,
  type HookTransportInterferenceTracker
} from '../shared/agent-hook-transport-interference'
import type { AgentHookSource } from '../shared/agent-hook-relay'
import { nextStepChatHookReplyBody } from '../shared/next-step-chat-hook-reply'
import { hookBodyEnv, hookBodyVersion } from './agent-hook-envelope-build'
import type { AgentHookResultRetryScheduler } from './agent-hook-result-retry-scheduler'

export type AgentHookRequestHandlingDeps = {
  token: string
  state: HookListenerState
  env: string
  transportInterference: HookTransportInterferenceTracker
  retryScheduler: AgentHookResultRetryScheduler
  flushSpool?: () => Promise<void>
  applyEvent: (
    event: AgentHookEventPayload,
    source: AgentHookSource,
    env?: string,
    version?: string,
    options?: { isReplay?: boolean; rawBody?: unknown }
  ) => boolean
}

/**
 * Handles one inbound POST to the loopback relay hook server: auth, slowloris cap, body parsing,
 * event normalization/application, and the fail-open response contract (204 on any error so a
 * buggy agent never blocks the run; errors are still logged and, for truncations, counted so a
 * blocked SSH relay reports the cause instead of an anonymous "hook request failed").
 */
export async function handleAgentHookRequest(
  deps: AgentHookRequestHandlingDeps,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(404)
    res.end()
    return
  }
  if (!hasValidAgentHookToken(req.headers, deps.token)) {
    res.writeHead(403)
    res.end()
    return
  }
  // Why: track our own destroy so the slowloris cap can't be misread as outside interference.
  let destroyedBySlowlorisCap = false
  req.setTimeout(HOOK_REQUEST_SLOWLORIS_MS, () => {
    destroyedBySlowlorisCap = true
    req.destroy()
  })
  try {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const source = resolveHookSource(pathname)
    if (!source) {
      res.writeHead(404)
      res.end()
      return
    }
    const body = await readRequestBody(req)
    await deps.flushSpool?.()
    const hookBody = mergeAgentHookRequestHeaders(body, req.headers)
    await prepareCodexHookTranscript(deps.state, source, hookBody, deps.env)
    const event = normalizeHookPayload(deps.state, source, hookBody, deps.env, {
      deferCompactOwnershipToClient: true
    })
    let pointer: string | null = null
    if (event) {
      // TODO: once normalizeHookPayload returns validated env/version, drop bodyEnv/bodyVersion and source them from the listener result.
      const env = hookBodyEnv(hookBody)
      const version = hookBodyVersion(hookBody)
      if (deps.applyEvent(event, source, env, version, { rawBody: hookBody })) {
        deps.retryScheduler.scheduleAssistantMessageRetry(source, hookBody, event, env, version)
        deps.retryScheduler.scheduleCodexSubagentPoll(source, hookBody, event, env, version)
        pointer = nextStepChatHookReplyBody({ source, event, body: hookBody })
      }
    }
    if (pointer) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(pointer)
      return
    }
    // Why: only a next-step or wait message gets a pointer at `outcome context` (above).
    res.writeHead(204)
    res.end()
  } catch (err) {
    // Why (#11217): a remote host can run the same IDS; count truncations here so a blocked SSH
    // relay reports the cause instead of an anonymous "hook request failed".
    if (isHookRequestTruncatedError(err) && !destroyedBySlowlorisCap) {
      deps.transportInterference.record({ source: null, error: err })
    }
    // Why: hooks fail open (204 on any error) so a buggy agent never blocks the run; still log so the 204 doesn't mask bugs.
    process.stderr.write(
      `[relay-hook-server] hook request failed: ${err instanceof Error ? err.message : String(err)}\n`
    )
    res.writeHead(204)
    res.end()
  }
}
