/**
 * This computer as the SOURCE of a transfer or relocation, over its own panes: it answers for a
 * registered conversation only through the pane its registration binds, asks for a brief through
 * the owner service's own ask (under the transfer's operation), and freezes a conversation by
 * ending its verified agent process group, proven by the process table (the agent and its group
 * gone, only a shell left).
 */

import { conversationSourcesEqual } from '../../shared/conversation-source'
import { parseExecutionHostId } from '../../shared/execution-host'
import type { SessionHostAuthority } from '../../shared/session-host-authority'
import type { HostOrganizationOutcome } from '../../shared/session-organization-host'
import { sessionHostRefusal, type SessionHostRefusal } from '../../shared/session-host-refusal'
import type { SessionManageActor } from '../../shared/session-manage-types'
import { ConversationNotSentError } from '../runtime/conversation-delivery-not-sent'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { SESSION_MANAGE_ASK_DEFAULT_TIMEOUT_MS } from '../runtime/rpc/methods/session-manage-schemas'
import { prepareSessionTarget } from '../runtime/rpc/methods/session-manage-support'
import type { SessionHostTurnReading } from '../session-host/session-host-admission-facts'
import type { SessionHostRegistration } from '../session-host/session-host-journal'
import { assertTransferSession, type TransferSession } from './session-manage-transfer-contract'
import type {
  RelocationExitEvidence,
  RelocationSourceHost,
  TransferSourceHost,
  TransferSourceStepInput
} from './session-transfer-host-action-deps'
import {
  awaitRelocationExit,
  processGroupGone,
  signalAgentProcessGroup
} from './session-transfer-process-group'
import { locateTranscripts } from './session-transcript-locate'

export type RuntimeTransferSourceWiring = {
  runtime: OrcaRuntimeService
  userDataPath: string
  /** The session-manage actor an authority acts as (B's owner service maps it). */
  actorOf(authority: SessionHostAuthority): SessionManageActor
  /**
   * Asks the conversation under this admitted operation and waits for its finished reply: the
   * owner service's own ask, which stamps the operation on the queued question so the send door
   * admits it through the transfer's reservation (a plain queued question would be refused).
   */
  ask(
    input: TransferSourceStepInput & { question: string; timeoutMs: number }
  ): Promise<
    | { outcome: 'answered'; reply: string }
    | { outcome: 'unsent'; reason: string }
    | { outcome: 'failed'; reason: string }
  >
  /** The executor's own turn reading, so a brief's checkpoint is the revision admission reads. */
  readTurn(registration: SessionHostRegistration): Promise<SessionHostTurnReading>
  /** One archive through the organization host (D's apply) under this operation id. */
  archive(input: TransferSourceStepInput & { reason?: string }): Promise<HostOrganizationOutcome>
  signal?: AbortSignal
}

const refusal = (message: string): SessionHostRefusal => sessionHostRefusal('not-eligible', message)

/** The pane this registration binds, read now; a refusal when it no longer holds it here. */
async function sessionOf(
  runtime: OrcaRuntimeService,
  registration: SessionHostRegistration
): Promise<TransferSession | SessionHostRefusal> {
  const binding = registration.binding
  if (!binding) {
    return refusal('That conversation has no pane on this computer. Nothing was changed.')
  }
  const prepared = await prepareSessionTarget(runtime, { paneKey: binding.paneKey }).catch(
    () => null
  )
  if (!prepared?.source || !conversationSourcesEqual(prepared.source, binding)) {
    return refusal(
      'Its pane on this computer no longer holds that conversation. Nothing was changed.'
    )
  }
  if (parseExecutionHostId(prepared.row.hostId)?.kind !== 'local') {
    return refusal(
      'That conversation runs on another computer, which answers for it. Nothing was changed.'
    )
  }
  return {
    entry: prepared.entry,
    row: prepared.row,
    source: prepared.source,
    agentProcess: prepared.agentProcess
  }
}

export function runtimeTransferSourceHost(wiring: RuntimeTransferSourceWiring): TransferSourceHost {
  const { runtime } = wiring
  return {
    eligible: async ({ registration, authority }) => {
      const session = await sessionOf(runtime, registration)
      if ('code' in session) {
        return session
      }
      try {
        assertTransferSession(wiring.actorOf(authority), session)
        return null
      } catch (error) {
        return refusal(error instanceof Error ? error.message : String(error))
      }
    },
    askBrief: async ({ registration, authority, operationId, question }) => {
      const session = await sessionOf(runtime, registration)
      if ('code' in session) {
        throw new ConversationNotSentError(session.message)
      }
      const asked = await wiring.ask({
        registration,
        authority,
        operationId,
        question,
        timeoutMs: SESSION_MANAGE_ASK_DEFAULT_TIMEOUT_MS
      })
      if (asked.outcome === 'unsent') {
        throw new ConversationNotSentError(asked.reason)
      }
      if (asked.outcome !== 'answered') {
        throw new Error(asked.reason)
      }
      const turn = await wiring.readTurn(registration)
      if (turn === 'unreadable' || !turn.turnRevision) {
        throw new Error(
          'Its turn after the brief could not be read, so the brief cannot be checked later.'
        )
      }
      return { reply: asked.reply, turnRevision: turn.turnRevision }
    },
    archive: async (input) => {
      const outcome = await wiring.archive(input)
      return outcome.status === 'applied'
        ? { archived: true }
        : {
            archived: false,
            detail: outcome.status === 'refused' ? outcome.refusal.message : outcome.error
          }
    }
  }
}

export function runtimeRelocationSourceHost(
  wiring: RuntimeTransferSourceWiring
): RelocationSourceHost {
  const { runtime } = wiring
  // The group each freeze ended, so later steps re-prove the same group is still gone.
  const ended = new Map<string, number>()
  const evidence = async (
    registration: SessionHostRegistration
  ): Promise<RelocationExitEvidence> => {
    const session = await sessionOf(runtime, registration)
    if ('code' in session) {
      return { stopped: false, reason: session.message }
    }
    const group = ended.get(registration.conversationId)
    if (
      session.entry.verdict !== 'exited' ||
      session.agentProcess ||
      (group !== undefined && !processGroupGone(group))
    ) {
      return {
        stopped: false,
        reason: `it is ${session.entry.verdict} (${session.entry.waitingOn ?? session.entry.state})`
      }
    }
    return {
      stopped: true,
      evidence: 'No agent process is left under its terminal and its process group is gone.'
    }
  }
  return {
    freeze: async ({ registration }) => {
      if (process.platform === 'win32') {
        return {
          stopped: false,
          reason: 'Stopping with proof of exit is not available on Windows yet.'
        }
      }
      const session = await sessionOf(runtime, registration)
      if ('code' in session) {
        return { stopped: false, reason: session.message }
      }
      const proof = session.agentProcess
      if (session.entry.verdict === 'exited' && !proof) {
        return await evidence(registration)
      }
      if (!proof || session.entry.agentForeground !== true) {
        return {
          stopped: false,
          reason: 'its agent process holding the terminal cannot be verified'
        }
      }
      if (session.entry.state !== 'idle') {
        return {
          stopped: false,
          reason: `it is ${session.entry.state}; only an idle conversation is frozen`
        }
      }
      const unsignalled = signalAgentProcessGroup(proof, (pgid) =>
        ended.set(registration.conversationId, pgid)
      )
      if (unsignalled) {
        return { stopped: false, reason: unsignalled }
      }
      return await awaitRelocationExit(() => evidence(registration))
    },
    exitEvidence: evidence,
    transcriptPath: async (registration) => {
      const { agent, sessionId } = registration.provider
      if (agent !== 'claude' && agent !== 'codex') {
        return null
      }
      const reported = registration.binding
        ? runtime
            .getReportedProviderSessionsForPane(registration.binding.paneKey)
            .find((session) => session.id === sessionId)
        : undefined
      if (reported?.transcriptPath) {
        return reported.transcriptPath
      }
      const located = await locateTranscripts(agent, sessionId, {
        userDataPath: wiring.userDataPath
      }).catch(() => [])
      return located.length === 1 ? located[0]!.path : null
    },
    retire: async (input) => {
      await wiring.archive({
        ...input,
        reason: 'moved to another computer; its history stays here'
      })
    }
  }
}
