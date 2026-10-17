import type { AcpStructuredAgent } from '../../../shared/acp-agent-recipes'
import { structuredLaunchOptions } from './structured-codex-launch-fallback'
import type { SessionOptionValue } from '../../../shared/native-chat-session-options'
import { toast } from 'sonner'
import {
  createStructuredCodexSessionLaunchIntent,
  launchStructuredCodexSession,
  StructuredAgentSessionCreateRefusalError,
  type StructuredAgentSessionLaunchIntent,
  type StructuredCodexLaunchRequest
} from '@/lib/launch-structured-codex-session'
import { refreshLocalStructuredSessionTabs } from '@/runtime/local-structured-session-tabs-sync'
import { translate } from '@/i18n/i18n'
import { queueStructuredLaunchPrompt } from './structured-launch-prompt-queue'

type StructuredLaunchState = {
  intent: StructuredAgentSessionLaunchIntent
  promise: Promise<string>
  visibilityUnknown: boolean
}

const pendingStructuredLaunchesByKey = new Map<string, StructuredLaunchState>()

function trackLaunchSettlement(
  launchKey: string,
  state: StructuredLaunchState,
  promise: Promise<string>
): void {
  void promise.then(
    () => {
      if (state.promise === promise && pendingStructuredLaunchesByKey.get(launchKey) === state) {
        pendingStructuredLaunchesByKey.delete(launchKey)
      }
    },
    () => {
      if (
        state.promise === promise &&
        !state.visibilityUnknown &&
        pendingStructuredLaunchesByKey.get(launchKey) === state
      ) {
        pendingStructuredLaunchesByKey.delete(launchKey)
      }
    }
  )
}

async function verifyPublishedSession(intent: StructuredAgentSessionLaunchIntent): Promise<string> {
  const snapshots = await refreshLocalStructuredSessionTabs()
  const published = snapshots.some(
    (snapshot) =>
      snapshot.worktree === intent.worktreeId &&
      snapshot.tabs.some(
        (tab) => tab.type === 'agent-session' && tab.sessionId === intent.sessionId
      )
  )
  if (!published) {
    throw new Error('structured session tab publication unavailable')
  }
  return intent.sessionId
}

async function retrySameIntent(state: StructuredLaunchState, priorError: unknown): Promise<string> {
  try {
    await launchStructuredCodexSession(state.intent)
    return await verifyPublishedSession(state.intent)
  } catch (error) {
    if (error instanceof StructuredAgentSessionCreateRefusalError) {
      throw error
    }
    try {
      return await verifyPublishedSession(state.intent)
    } catch {
      state.visibilityUnknown = true
      throw error ?? priorError
    }
  }
}

async function launchAndReconcile(state: StructuredLaunchState): Promise<string> {
  try {
    await launchStructuredCodexSession(state.intent)
  } catch (error) {
    if (error instanceof StructuredAgentSessionCreateRefusalError) {
      throw error
    }
    try {
      return await verifyPublishedSession(state.intent)
    } catch {
      return retrySameIntent(state, error)
    }
  }
  try {
    return await verifyPublishedSession(state.intent)
  } catch (error) {
    return retrySameIntent(state, error)
  }
}

async function reconcileUnknownLaunch(state: StructuredLaunchState): Promise<string> {
  state.visibilityUnknown = false
  try {
    return await verifyPublishedSession(state.intent)
  } catch (error) {
    return retrySameIntent(state, error)
  }
}

function launchStructuredCodexSessionOnce(
  worktreeId: string,
  request: StructuredCodexLaunchRequest = {}
): Promise<string> {
  const launchKey = request.launchKey ? `${worktreeId}:${request.launchKey}` : worktreeId
  const existing = pendingStructuredLaunchesByKey.get(launchKey)
  if (existing) {
    if (existing.visibilityUnknown) {
      existing.promise = reconcileUnknownLaunch(existing)
      trackLaunchSettlement(launchKey, existing, existing.promise)
    }
    return existing.promise
  }
  const state: StructuredLaunchState = {
    intent: createStructuredCodexSessionLaunchIntent(worktreeId, request),
    promise: Promise.resolve(''),
    visibilityUnknown: false
  }
  // Why after publication: the outbox is keyed by session id and drains once the
  // chat attaches, so the opening prompt becomes exactly one accepted turn.
  state.promise = launchAndReconcile(state).then((sessionId) => {
    if (state.intent.prompt) {
      if (!queueStructuredLaunchPrompt(sessionId, state.intent.prompt)) {
        throw new Error(
          'The new session opened, but its prompt could not be saved. Open the session to continue.'
        )
      }
    }
    return sessionId
  })
  pendingStructuredLaunchesByKey.set(launchKey, state)
  trackLaunchSettlement(launchKey, state, state.promise)
  return state.promise
}

export function startStructuredCodexLaunch(
  worktreeId: string,
  request: StructuredCodexLaunchRequest = {}
): Promise<boolean> {
  return launchStructuredCodexSessionOnce(worktreeId, request)
    .then(() => true)
    .catch((error) => {
      toast.error(
        translate(
          'components.native-chat.structuredSessionLaunchFailed',
          'Could not open agent chat'
        ),
        { description: error instanceof Error ? error.message : String(error) }
      )
      return false
    })
}

/** Report publication and durable outbox enqueue before the launcher claims success. */
export function startStructuredChatLaunch(
  worktreeId: string,
  options: Record<string, SessionOptionValue> | undefined,
  prompt: string | undefined,
  onPromptDelivered?: () => void,
  agent?: AcpStructuredAgent,
  /** How the named agent is driven. Defaults to `acp` because that was the only
   *  non-Codex lane before the Claude Agent SDK one, and every existing caller
   *  that names an agent means ACP. The SDK lane passes `agent-session`, which
   *  records no transport at all and lets the host's own router decide. */
  transport: 'acp' | 'agent-session' = 'acp',
  /** Which launch this belongs to, so a cold conversation dedupes against its own
   *  reservation instead of starting a second session. */
  target?: Pick<
    StructuredCodexLaunchRequest,
    'launchKey' | 'groupId' | 'onSessionCreated' | 'navigate'
  >
) {
  const routeThroughAcp = agent !== undefined && transport === 'acp'
  return startStructuredCodexLaunch(worktreeId, {
    navigate: target?.navigate,
    ...(target?.onSessionCreated ? { onSessionCreated: target.onSessionCreated } : {}),
    ...(target?.launchKey ? { launchKey: target.launchKey } : {}),
    ...(target?.groupId ? { groupId: target.groupId } : {}),
    ...(agent ? { agent } : {}),
    options: {
      ...structuredLaunchOptions(options),
      ...(routeThroughAcp ? { transport: 'acp' } : {}),
      chatPermissionMode: 'bypass',
      approvalPolicy: 'never'
    },
    ...(prompt ? { prompt } : {})
  }).then((delivered) => {
    if (delivered && prompt) {
      onPromptDelivered?.()
    }
    return { delivered, failureNotified: !delivered }
  })
}
