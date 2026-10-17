/**
 * Keeps the account registry in step with the panes this relay runs, by the same rules a paired
 * runtime uses: every pane whose agent reported a provider session is registered; one is adopted
 * only while its PTY lives here, its agent holds the terminal, and a finished turn is known. After
 * a restart, a prompt a dead relay left unknown is settled once the conversation takes a new turn.
 */

import { sameConversationSource } from '../shared/conversation-source'
import type { SessionHostAdmissionStore } from '../main/session-host/session-host-admission-store'
import type { SessionHostRegistration } from '../main/session-host/session-host-journal'
import { registerSessionHostConversation } from '../main/session-host/session-host-ownership-registry'
import { reconcileSessionHostOperation } from '../main/session-host/session-host-reservation-release'
import { relocatedAwayIn } from '../main/session-host-owner/session-host-relocated-journal'
import {
  relayAgentHoldsTerminal,
  relayOwnerSessions,
  type RelayOwnerFacts,
  type RelayOwnerSession
} from './relay-owner-sessions'
import type { RelayTurnLedger } from './relay-owner-turns'

function unchanged(
  existing: SessionHostRegistration,
  session: RelayOwnerSession,
  adopt: boolean,
  controller: string
): boolean {
  return (
    existing.controller === controller &&
    (existing.adopted || !adopt) &&
    existing.processIncarnation === `pty:${session.pane?.ptyId ?? ''}` &&
    existing.binding !== null &&
    session.source !== null &&
    sameConversationSource(existing.binding, session.source)
  )
}

export async function adoptRelaySessions(input: {
  store: SessionHostAdmissionStore
  facts: RelayOwnerFacts
  turns: RelayTurnLedger
}): Promise<{ registered: number; adopted: number }> {
  const result = { registered: 0, adopted: 0 }
  const controller = input.store.host.incarnation
  for (const session of relayOwnerSessions(input.facts, input.turns)) {
    const journal = input.store.snapshot()
    const { agent, providerSessionId, source } = session
    if (!journal || !agent || !providerSessionId || !source || session.verdict !== 'live') {
      continue
    }
    const provider = { agent, sessionId: providerSessionId }
    if (relocatedAwayIn(journal, provider)) {
      continue
    }
    const adopt =
      session.turnRevision !== null && (await relayAgentHoldsTerminal(input.facts, session))
    const existing = Object.values(journal.conversations).find(
      (registration) =>
        registration.owned &&
        registration.provider.agent === agent &&
        registration.provider.sessionId === providerSessionId
    )
    if (existing && unchanged(existing, session, adopt, controller)) {
      continue
    }
    const registered = await registerSessionHostConversation(input.store, {
      provider,
      binding: source,
      workspace: null,
      processIncarnation: `pty:${session.pane?.ptyId ?? ''}`,
      adopted: adopt
    }).catch(() => null)
    if (registered?.status === 'ok') {
      result.registered += 1
      result.adopted += registered.registration.adopted ? 1 : 0
    }
  }
  return result
}

/** A prompt a dead relay left `unconfirmed` counts as delivered once its turn has moved on. */
export async function reconcileRelayDeliveries(input: {
  store: SessionHostAdmissionStore
  turns: RelayTurnLedger
}): Promise<number> {
  const journal = input.store.snapshot()
  let settled = 0
  for (const operation of Object.values(journal?.operations ?? {})) {
    if (
      operation.state !== 'unconfirmed' ||
      (operation.action !== 'continue' && operation.action !== 'ask')
    ) {
      continue
    }
    const paneKey = journal?.conversations[operation.conversationId]?.binding?.paneKey
    const current = paneKey ? input.turns.revision(paneKey) : null
    if (current !== null && current !== operation.turnRevision) {
      const done = await reconcileSessionHostOperation(input.store, operation.operationId, {
        delivered: true,
        note: 'the conversation took a new turn after it'
      })
      settled += done ? 1 : 0
    }
  }
  return settled
}
