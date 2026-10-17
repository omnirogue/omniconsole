/**
 * A transfer source's two steps on the host that runs it. `transfer.prepare-source` asks the
 * conversation for its brief under the transfer's reservation and keeps holding it, so no automatic
 * work reaches it while the target takes over. `transfer.settle-source` then archives it (target
 * accepted, turn unchanged since the brief) or releases it (abandoned). Neither is ever resent.
 */

import type { SessionHostPayloads } from '../../shared/session-host-payload-schema'
import { sessionHostRefusal } from '../../shared/session-host-refusal'
import { ConversationNotSentError } from '../runtime/conversation-delivery-not-sent'
import type {
  SessionHostExecutionInput,
  SessionHostPrepared
} from '../session-host/session-host-executor'
import type { SessionHostJournal } from '../session-host/session-host-journal'
import type { SessionTransferHostActionDeps } from './session-transfer-host-action-deps'
import { TRANSFER_HANDOFF_QUESTION, TRANSFER_SUMMARY_QUESTION } from './session-transfer-questions'

const refuse = (
  code: Parameters<typeof sessionHostRefusal>[0],
  message: string
): SessionHostPrepared => ({ kind: 'refuse', refusal: sessionHostRefusal(code, message) })

const NO_SOURCE = refuse(
  'unsupported-capability',
  'This computer cannot give a brief for a transfer. Nothing was changed.'
)

/** The completed prepare step of this transfer on this conversation, if any. */
export function preparedTransferSource(
  journal: SessionHostJournal | null,
  conversationId: string,
  transfer: string
): { brief: string | null; checkpoint: string | null } | null {
  for (const operation of Object.values(journal?.operations ?? {})) {
    const result = operation.result as { transfer?: unknown; brief?: unknown; checkpoint?: unknown }
    if (
      operation.action === 'transfer.prepare-source' &&
      operation.conversationId === conversationId &&
      operation.state === 'completed' &&
      result?.transfer === transfer
    ) {
      return {
        brief: typeof result.brief === 'string' ? result.brief : null,
        checkpoint: typeof result.checkpoint === 'string' ? result.checkpoint : null
      }
    }
  }
  return null
}

export async function prepareTransferSource(
  deps: SessionTransferHostActionDeps,
  input: SessionHostExecutionInput
): Promise<SessionHostPrepared> {
  const source = deps.transferSource
  const { registration, request, operation, authority } = input
  if (!source) {
    return NO_SOURCE
  }
  if (!registration) {
    return refuse(
      'unknown-conversation',
      'That computer has no such conversation. Nothing was changed.'
    )
  }
  const payload = request.payload as SessionHostPayloads['transfer.prepare-source']
  if (
    payload.target.hostId === deps.store.host.hostId &&
    payload.target.conversationId === request.conversationId
  ) {
    return refuse(
      'invalid-request',
      'A conversation cannot be handed off to itself. Nothing was changed.'
    )
  }
  const step = { registration, operationId: operation.operationId, authority }
  const ineligible = await source.eligible(step)
  if (ineligible) {
    return { kind: 'refuse', refusal: ineligible }
  }
  const question =
    payload.mode === 'handoff' ? TRANSFER_HANDOFF_QUESTION : TRANSFER_SUMMARY_QUESTION
  return {
    kind: 'dispatch',
    dispatch: async () => {
      try {
        const answered = await source.askBrief({ ...step, marker: input.marker, question })
        return {
          kind: 'completed',
          result: {
            transfer: payload.transfer,
            brief: answered.reply,
            checkpoint: answered.turnRevision
          }
        }
      } catch (error) {
        if (error instanceof ConversationNotSentError) {
          return {
            kind: 'not-delivered',
            refusal: sessionHostRefusal('not-eligible', `${error.message} Nothing was sent.`)
          }
        }
        // Why completed: the question may have arrived; the reservation stays until it is settled.
        return {
          kind: 'completed',
          result: {
            transfer: payload.transfer,
            brief: null,
            failure: error instanceof Error ? error.message : String(error)
          }
        }
      }
    }
  }
}

export async function prepareTransferSettlement(
  deps: SessionTransferHostActionDeps,
  input: SessionHostExecutionInput
): Promise<SessionHostPrepared> {
  const source = deps.transferSource
  const { registration, request, operation, authority } = input
  if (!source) {
    return NO_SOURCE
  }
  if (!registration) {
    return refuse(
      'unknown-conversation',
      'That computer has no such conversation. Nothing was changed.'
    )
  }
  const payload = request.payload as SessionHostPayloads['transfer.settle-source']
  if (payload.outcome === 'abandoned') {
    return {
      kind: 'dispatch',
      dispatch: async () => ({
        kind: 'completed',
        result: { transfer: payload.transfer, settled: 'abandoned' },
        reservation: 'release'
      })
    }
  }
  const prepared = preparedTransferSource(
    deps.store.snapshot(),
    request.conversationId,
    payload.transfer
  )
  if (!prepared?.brief) {
    return refuse(
      'not-eligible',
      'This conversation gave no brief for that transfer, so it is not archived. Nothing was changed.'
    )
  }
  const receipt = payload.targetReceipt!
  const reason = `handed off (transfer ${payload.transfer}) to conversation ${receipt.conversationId} on ${receipt.hostId}`
  return {
    kind: 'dispatch',
    dispatch: async () => {
      const archived = await source
        .archive({ registration, operationId: operation.operationId, authority, reason })
        .catch((error: unknown) => ({
          archived: false as const,
          detail: error instanceof Error ? error.message : String(error)
        }))
      return {
        kind: 'completed',
        result: { transfer: payload.transfer, settled: 'accepted', ...archived },
        // Why release when not archived: it stays visible and usable; it was never moved.
        reservation: archived.archived ? 'settle' : 'release'
      }
    }
  }
}
