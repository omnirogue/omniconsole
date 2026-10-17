import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { AgentSessionDispatchOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { isCodexAppServerRequestError } from './codex-app-server-connection'
import { isCodexAppServerUnsupportedError } from './codex-app-server-session'
import { readCodexTurnId } from './codex-structured-thread-facts'
import { turnInputFor, type CodexTurnHost } from './codex-structured-turn-start'
import {
  codexSteeringClientId,
  codexSteeringMessageIdentity
} from './codex-steering-message-identity'

/** Steering joins the active provider turn without holding Stop behind a transcript echo. */
export class CodexStructuredLiveInput {
  activeTurnId: string | null = null
  revision = 0
  private lastSteer: { turnId: string; clientMessageId: string } | null = null

  steeringMessageForTurn(turnId: string): string | undefined {
    return this.lastSteer?.turnId === turnId ? this.lastSteer.clientMessageId : undefined
  }
  observe(method: string, params: unknown): void {
    const turnId = readCodexTurnId(params)
    if (!turnId) {
      return
    }
    if (method === 'turn/started') {
      this.revision++
      this.activeTurnId = turnId
    } else if (method === 'turn/completed') {
      this.revision++
      if (this.activeTurnId === turnId) {
        this.activeTurnId = null
      }
    }
  }

  async steer(
    host: CodexTurnHost,
    input: {
      clientMessageId: string
      body: AgentJournalMessageItem
    },
    timeoutMs = 10_000
  ): Promise<AgentSessionDispatchOutcome> {
    const turnId = this.activeTurnId
    if (!turnId) {
      return { state: 'rejected', reason: 'The active turn finished. Send the message again.' }
    }
    // Register before RPC: completion and echo may both arrive before its receipt.
    this.lastSteer = { turnId, clientMessageId: input.clientMessageId }
    const clientId = codexSteeringClientId(input.clientMessageId)
    try {
      const receipt = await host.connection.request(
        'turn/steer',
        {
          threadId: host.threadId,
          expectedTurnId: turnId,
          clientUserMessageId: clientId,
          input: turnInputFor(input.body)
        },
        { timeoutMs }
      )
      if (readCodexTurnId(receipt) !== turnId) {
        return { state: 'unknown', reason: 'Codex did not confirm the expected steering turn.' }
      }
      return {
        state: 'accepted',
        providerIdentity: codexSteeringMessageIdentity(clientId)!
      }
    } catch (error) {
      if (isCodexAppServerRequestError(error) || isCodexAppServerUnsupportedError(error)) {
        return { state: 'rejected', reason: (error as Error).message }
      }
      throw error
    }
  }
}
