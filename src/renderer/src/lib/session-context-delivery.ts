import { useAppStore } from '@/store'
import { callRuntimeRpc, hasRuntimeRpcErrorCode } from '@/runtime/runtime-rpc-client'
import { sessionContextText } from '../../../shared/session-context-attachments'
import { promptQueueTextRefusal } from '../../../shared/prompt-queue-types'
import {
  SESSION_CONTEXT_ENQUEUE_RPC,
  type SessionContextQueueIdentity
} from '../../../shared/session-context-queue'
import {
  getSessionContext,
  sessionContextForSource,
  sessionContextKey
} from './session-context-store'
import { buildPaneSessions, type SidebarSession } from './sidebar-sessions'
import { upNextAddressForSession } from './up-next-address'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { selectConsoleAccountScope } from './console-account-scope'

/** The host's durable queue waits for the agent to accept another message. */
export async function deliverSessionContext(
  session: SidebarSession,
  expectedKey?: string,
  options: { id?: string } = {}
): Promise<'queued' | 'next-turn'> {
  const scope = selectConsoleAccountScope(useAppStore.getState())
  const key = sessionContextKey(session)
  if (expectedKey && expectedKey !== key) {
    throw new Error('The account changed before context could be queued.')
  }
  const current = buildPaneSessions(useAppStore.getState()).find(
    (row) => sessionContextKey(row) === key
  )
  const address = current && !current.unavailable ? upNextAddressForSession(current) : null
  if (!address) {
    return 'next-turn'
  }
  const identity: SessionContextQueueIdentity | null =
    address.source.kind === 'structured' && address.source.sessionId
      ? { kind: 'structured', sessionId: address.source.sessionId }
      : current?.providerSession
        ? {
            kind: 'pty',
            agent: current.agent,
            providerSession: {
              key: current.providerSession.key,
              id: current.providerSession.id
            }
          }
        : null
  if (!identity) {
    throw new Error('The session identity is not ready. Saved context is kept for its next turn.')
  }
  const context = sessionContextText(getSessionContext(key))
  const text = context
    ? `The user updated this session’s attached context. Use this current attachment set for future continuation.\n\n${context}`
    : 'The user removed all saved attachments from this session. Do not carry previously attached files or documents into a new continuation unless the user asks.'
  const refusal = promptQueueTextRefusal(text)
  if (refusal) {
    throw new Error(refusal)
  }
  if (selectConsoleAccountScope(useAppStore.getState()) !== scope) {
    throw new Error('The account changed before context could be queued.')
  }
  try {
    await callRuntimeRpc(address.owner, SESSION_CONTEXT_ENQUEUE_RPC, {
      source: address.source,
      id: options.id ?? crypto.randomUUID(),
      text,
      identity
    })
  } catch (error) {
    if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
      throw new Error('Update OmniConsole on the session’s computer to queue saved context.')
    }
    throw error
  }
  return 'queued'
}

export function prependSessionContext(text: string, sourceKey: string, hostId?: string): string {
  if (text.trimStart().startsWith('/')) {
    return text
  }
  const context = sessionContextText(sessionContextForSource(sourceKey, hostId))
  return context && !text.includes(context) ? `${text}\n\n${context}` : text
}

export function prependPtySessionContext(text: string, tabId: string, ptyId: string): string {
  const state = useAppStore.getState()
  const leaves = Object.entries(state.terminalLayoutsByTabId?.[tabId]?.ptyIdsByLeafId ?? {}).filter(
    ([, id]) => id === ptyId
  )
  if (leaves.length !== 1) {
    return text
  }
  const session = buildPaneSessions(state).find(
    (row) => row.tabId === tabId && row.paneKey === makePaneKey(tabId, leaves[0]![0])
  )
  return session?.paneKey
    ? prependSessionContext(text, session.paneKey, session.hostId ?? undefined)
    : text
}
