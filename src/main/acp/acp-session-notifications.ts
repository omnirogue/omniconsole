import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { agentJournalTurnSettlementOutcome } from '../../shared/agent-session-journal-types'
import type {
  AgentJournalToolCallItem,
  AgentJournalTurnOutcome
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionAcquireInput } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AcpJsonRpcConnection, AcpJsonRpcConnectionHandlers } from './acp-jsonrpc-connection'
import {
  indexAcpConfigOptions,
  type AcpConfigIndex,
  type AcpConfigOption
} from './acp-session-config'
import {
  applyAcpServerRequest,
  applyAcpSessionUpdate,
  type AcpPendingPrompt
} from './acp-session-events'

export type AcpSession = {
  connection: AcpJsonRpcConnection
  acpSessionId: string
  agent: string
  fence: number
  imageCapable: boolean
  config: AcpConfigIndex
  pendingPermissions: Map<string, AcpPendingPrompt>
  promptCount: number
  assistant: { text: string }
  events: StructuredAgentSessionAcquireInput['events']
  bypass: boolean
  options: Record<string, string>
  sourceOptions?: { clientMessageId: string; model?: string; effort?: string }
  activeTurnId: string | null
  cancelRequestedTurnId?: string
  acceptTurn?: () => void
  tools: Map<string, AgentJournalToolCallItem>
}

export function publishAcpTurn(
  session: AcpSession,
  turnId: string,
  state: 'running' | 'completed',
  outcome?: AgentJournalTurnOutcome
): void {
  session.events?.appendItem(
    {
      provider: 'legacy',
      agent: session.agent,
      sessionId: session.acpSessionId,
      recordId: `${turnId}:status`
    },
    {
      kind: 'status',
      text: '',
      // Both readings of the same ending are written: `outcome` distinguishes an interrupt from
      // a failure, `settlement` binds the ending to the exact admission receipt. Dropping either
      // would silently disable one of the two source-readiness refusals downstream.
      turnLifecycle: {
        turnId,
        state,
        ...(outcome ? { outcome } : {}),
        ...(state === 'completed' && outcome
          ? {
              settlement: {
                providerItemId: agentJournalItemKey({
                  provider: 'legacy',
                  agent: session.agent,
                  sessionId: session.acpSessionId,
                  recordId: `${turnId}:user`
                }),
                outcome: agentJournalTurnSettlementOutcome(outcome)
              }
            }
          : {})
      }
    }
  )
  session.events?.publish()
}

export function createAcpSessionHandlers(args: {
  input: StructuredAgentSessionAcquireInput
  live: { connection?: AcpJsonRpcConnection }
  pendingPermissions: Map<string, AcpPendingPrompt>
  getSession: () => AcpSession | undefined
}): AcpJsonRpcConnectionHandlers {
  return {
    onNotification: (method, params) => {
      const session = args.getSession()
      if (
        method !== 'session/update' ||
        !session ||
        session.connection !== args.live.connection ||
        !params ||
        typeof params !== 'object'
      ) {
        return
      }
      const message = params as {
        sessionId?: string
        update?: { sessionUpdate?: string; configOptions?: AcpConfigOption[] }
      }
      if (message.sessionId && message.sessionId !== session.acpSessionId) {
        return
      }
      session.acceptTurn?.()
      if (
        message.update?.sessionUpdate === 'config_option_update' &&
        message.update.configOptions
      ) {
        session.config = indexAcpConfigOptions(message.update.configOptions)
      }
      applyAcpSessionUpdate({
        sessionId: args.input.identity.sessionId,
        agent: session.agent,
        acpSessionId: session.acpSessionId,
        assistantRecordId: `${session.activeTurnId ?? 'history'}:assistant`,
        assistant: session.assistant,
        tools: session.tools,
        params,
        events: args.input.events
      })
    },
    onServerRequest: (request) => {
      const session = args.getSession()
      if (session && session.connection !== args.live.connection) {
        return
      }
      const params = request.params as {
        sessionId?: string
        options?: { optionId?: string; kind?: string }[]
      } | null
      if (session && params?.sessionId && params.sessionId !== session.acpSessionId) {
        args.live.connection?.respondError(request.id, -32602, 'ACP session identity mismatch')
        return
      }
      session?.acceptTurn?.()
      if (
        request.method === 'session/request_permission' &&
        (session?.bypass ?? args.input.options?.chatPermissionMode === 'bypass')
      ) {
        const options = params?.options ?? []
        const allow =
          options.find((option) => option.kind === 'allow_once' && option.optionId) ??
          options.find((option) => option.kind === 'allow_always' && option.optionId)
        args.live.connection?.respond(request.id, {
          outcome: allow
            ? { outcome: 'selected', optionId: allow.optionId }
            : { outcome: 'cancelled' }
        })
        return
      }
      const handled = applyAcpServerRequest({
        sessionId: args.input.identity.sessionId,
        agent: args.input.identity.agent,
        acpSessionId: session?.acpSessionId ?? params?.sessionId ?? args.input.identity.sessionId,
        request,
        pending: args.pendingPermissions,
        events: args.input.events
      })
      if (handled === 'ignored') {
        args.live.connection?.respondError(
          request.id,
          -32601,
          `Unknown ACP method ${request.method}`
        )
      }
    },
    onExit: () => {
      const session = args.getSession()
      if (session?.connection === args.live.connection && session?.activeTurnId) {
        // The agent process went away mid-turn; that is loss of contact, not completion.
        publishAcpTurn(session, session.activeTurnId, 'completed', 'unknown')
      }
    }
  }
}
