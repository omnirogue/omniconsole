/**
 * The `message` kind: the person's own words for one of their conversations, sent from a Claude or
 * Codex app through OmniOS (`send_my_session_message`). The delivery's context names the
 * conversation (`provider` + `conversationId`, i.e. `<provider>:<conversationId>@local`) and its
 * text is typed exactly as OmniOS stored it (a one-line header naming the person and the app, then
 * their words).
 *
 * OmniOS offers it to every computer of the person that takes this kind, so it is resolved before
 * claiming and a computer that does not hold the conversation (no sidebar row and no transcript
 * here) leaves it alone. Delivery is the claimer's usual path: a live session gets it through its
 * prompt queue (sent when it is free), an archived one is unarchived first, an exited one is
 * resumed in the same conversation. A deleted or hidden conversation is held as `protection`, and
 * nothing is ever respawned: a gone transcript is held `transcript_gone`.
 */

import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import {
  formatSessionReference,
  parseSessionReference,
  rowsForSessionReference,
  type SessionReference
} from '../../shared/session-reference'
import { organizationFields } from '../answer-delivery/answer-delivery-target'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { readSidebarRows } from '../session-manage/session-manage-runtime-actions'
import { locateTranscripts } from '../session-manage/session-transcript-locate'
import type { ClaimableDelivery, WorkDeliveryKindAdapter } from './work-delivery-kind'

type MessageContext = { provider?: unknown; conversationId?: unknown }

/** The conversation a message delivery names, on this computer; null when it names none. */
export function messageReferenceOf(delivery: ClaimableDelivery): SessionReference | null {
  const context = (delivery.context ?? {}) as MessageContext
  const provider = typeof context.provider === 'string' ? context.provider : ''
  const conversationId = typeof context.conversationId === 'string' ? context.conversationId : ''
  if (!provider || !conversationId) {
    return null
  }
  return parseSessionReference(`${provider}:${conversationId}@local`)
}

export type MessageHoldDeps = {
  rows(): Promise<readonly SessionManageSidebarRow[]>
  transcripts(reference: SessionReference): Promise<number>
}

/** This computer holds the conversation: a sidebar row lists it, or its transcript is here. */
export async function holdsConversation(
  deps: MessageHoldDeps,
  reference: SessionReference
): Promise<boolean> {
  const rows = await deps.rows().catch(() => [] as readonly SessionManageSidebarRow[])
  if (rowsForSessionReference(reference, rows).length > 0) {
    return true
  }
  return (await deps.transcripts(reference).catch(() => 0)) > 0
}

export function messageDeliveryAdapter(
  userDataPath: string,
  holdDeps?: (runtime: OrcaRuntimeService) => MessageHoldDeps
): WorkDeliveryKindAdapter {
  const depsFor =
    holdDeps ??
    ((runtime: OrcaRuntimeService): MessageHoldDeps => ({
      rows: () => readSidebarRows(runtime),
      transcripts: async (reference) =>
        (await locateTranscripts(reference.agent, reference.sessionId, { userDataPath })).length
    }))
  return {
    kind: 'message',
    claimOnlyWhenHeld: true,
    noRespawn: true,
    resolve: async (delivery, runtime) => {
      const reference = messageReferenceOf(delivery)
      if (!reference || !(await holdsConversation(depsFor(runtime), reference))) {
        return null
      }
      // Why the owner only when it names this conversation: a binding is a previous delivery's pane.
      const owner =
        delivery.owner && delivery.owner.conversationId === reference.sessionId
          ? delivery.owner
          : null
      return {
        ref: formatSessionReference(reference),
        ...(owner?.paneKey ? { paneKey: owner.paneKey } : {}),
        ...(owner?.accountId ? { accountId: owner.accountId } : {}),
        ...(owner?.model ? { model: owner.model } : {}),
        ...(owner?.effort ? { effort: owner.effort } : {}),
        ...(owner?.folder ? { folder: owner.folder } : {}),
        ...(await organizationFields(runtime, reference.sessionId)),
        transcript: 'present'
      }
    },
    text: (delivery) => delivery.text
  }
}
