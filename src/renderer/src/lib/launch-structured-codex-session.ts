import type { AcpStructuredAgent } from '../../../shared/acp-agent-recipes'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionPayloadFingerprint
} from '../../../shared/structured-agent-session-mutation'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { useAppStore } from '@/store'
import {
  clearWebSessionFocusIntentIfMatches,
  recordWebSessionFocusIntent,
  resolveWebSessionVisibleTabId
} from '@/runtime/web-session-focus-intent'
import { LOCAL_STRUCTURED_SESSION_OWNER } from '@/runtime/local-structured-session-tabs-sync'
import type {
  StructuredAgentSessionCreateParams,
  StructuredAgentSessionResumeSource
} from '../../../shared/structured-agent-session-create'

/** What a launch asked for beyond the workspace: first-turn options and an opening prompt. */
export type StructuredCodexLaunchRequest = {
  navigate?: boolean
  onSessionCreated?: (tabId: string) => void
  agent?: AcpStructuredAgent
  /** Renderer intent identity and destination; neither grants execution authority. */
  launchKey?: string
  groupId?: string
  /** Model/effort recorded on the session so the first turn already carries them. */
  options?: Record<string, string>
  /** Queued to the session's outbox after create; sent once the chat attaches. */
  prompt?: string
  /** The provider conversation this launch adopts instead of starting a fresh one.
   *  Part of the create intent, so a retry replays the same adoption rather than
   *  conflicting with, or replaying as, a blank create. */
  resumeFrom?: StructuredAgentSessionResumeSource
}

export type StructuredAgentSessionLaunchIntent = {
  sessionId: string
  worktreeId: string
  params: StructuredAgentSessionCreateParams
  /** Opening prompt to queue once the session is published; absent for a bare launch. */
  prompt?: string | null
}

export class StructuredAgentSessionCreateRefusalError extends Error {}

export function createStructuredCodexSessionLaunchIntent(
  worktreeId: string,
  request: StructuredCodexLaunchRequest = {}
): StructuredAgentSessionLaunchIntent {
  const sessionId = `${request.agent ?? 'codex'}_${crypto.randomUUID().replaceAll('-', '_')}`
  request.onSessionCreated?.(`structured-agent-session-${sessionId}`)
  const options = Object.fromEntries(
    Object.entries(request.options ?? {}).filter(([, value]) => value.trim().length > 0)
  )
  const fields = {
    worktree: toRuntimeWorktreeSelector(worktreeId),
    agent: request.agent ?? 'codex',
    ...(Object.keys(options).length > 0 ? { options } : {}),
    ...(request.resumeFrom ? { resumeFrom: request.resumeFrom } : {})
  }
  const state = useAppStore.getState()
  if (request.navigate !== false) {
    recordWebSessionFocusIntent(
      { environmentId: LOCAL_STRUCTURED_SESSION_OWNER },
      worktreeId,
      `agent-session:${sessionId}`,
      request.groupId,
      resolveWebSessionVisibleTabId(state, worktreeId)
    )
  }
  return {
    sessionId,
    worktreeId,
    params: {
      envelope: {
        sessionId,
        clientOperationId: createStructuredAgentSessionOperationId(() => crypto.randomUUID()),
        expectedRuntimeFence: null,
        payloadFingerprint: structuredAgentSessionPayloadFingerprint({
          method: 'agentSession.create',
          sessionId,
          fields
        })
      },
      ...fields
    },
    prompt: request.prompt?.trim() ? request.prompt.trim() : null
  }
}

export function abandonStructuredAgentSessionLaunchIntent(
  intent: StructuredAgentSessionLaunchIntent
): void {
  clearWebSessionFocusIntentIfMatches(
    { environmentId: LOCAL_STRUCTURED_SESSION_OWNER },
    intent.worktreeId,
    `agent-session:${intent.sessionId}`
  )
}

export async function launchStructuredCodexSession(
  intent: StructuredAgentSessionLaunchIntent
): Promise<string> {
  const result = await callStructuredAgentSession<
    AgentSessionMutationResult<AgentSessionAttachResult>
  >({ kind: 'local' }, 'agentSession.create', intent.params)
  if (!result.ok) {
    abandonStructuredAgentSessionLaunchIntent(intent)
    throw new StructuredAgentSessionCreateRefusalError(result.refusal.message)
  }
  return result.value.sessionId
}
