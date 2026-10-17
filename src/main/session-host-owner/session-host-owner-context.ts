/**
 * What the owner service lends the action handlers it carries (package C's transfers and
 * relocation): the actor it maps an authority to, its turn reading, one archive through the
 * organization host, its account store, and a question sent under an operation the handler
 * already admitted, so the send door checks that operation rather than admitting a new one.
 */

import type {
  HostOrganizationApi,
  HostOrganizationOutcome
} from '../../shared/session-organization-host'
import type { SessionHostAuthority } from '../../shared/session-host-authority'
import { sessionHostRefusal } from '../../shared/session-host-refusal'
import type { SessionManageActor } from '../../shared/session-manage-types'
import type { SessionHostTurnReading } from '../session-host/session-host-admission-facts'
import type { SessionHostAdmissionStore } from '../session-host/session-host-admission-store'
import type { SessionHostRegistration } from '../session-host/session-host-journal'
import { executorForActor } from '../session-organization/organization-relayed-mutation'
import type { HostSessionInventory } from './host-session-inventory'
import { sessionHostActor } from './session-host-actor'
import { prepareHostAsk, type OwnerDeliveryDeps } from './session-host-owner-delivery'
import { resolveOwnerTarget } from './session-host-owner-target'

export type HostOwnerAskOutcome =
  | { outcome: 'answered'; reply: string }
  /** Nothing reached the conversation. */
  | { outcome: 'unsent'; reason: string }
  /** It may have arrived; no complete reply came back. */
  | { outcome: 'failed'; reason: string }

export type SessionHostOwnerContext = {
  actorOf(authority: SessionHostAuthority): SessionManageActor
  readTurn(registration: SessionHostRegistration): Promise<SessionHostTurnReading>
  /** One archive of the conversation through the organization host, under that operation id. */
  archive(input: {
    registration: SessionHostRegistration
    operationId: string
    authority: SessionHostAuthority
    reason?: string
  }): Promise<HostOrganizationOutcome>
  store(): SessionHostAdmissionStore | null
  /** A question under an operation the caller already admitted and dispatched (a transfer's brief). */
  ask(input: {
    registration: SessionHostRegistration
    authority: SessionHostAuthority
    operationId: string
    question: string
    timeoutMs?: number
  }): Promise<HostOwnerAskOutcome>
}

export function sessionHostOwnerContext(deps: {
  inventory: HostSessionInventory
  delivery: OwnerDeliveryDeps
  organization(): HostOrganizationApi | null
  readTurn(registration: SessionHostRegistration): Promise<SessionHostTurnReading>
  store(): SessionHostAdmissionStore | null
}): SessionHostOwnerContext {
  const { inventory } = deps
  return {
    actorOf: sessionHostActor,
    readTurn: deps.readTurn,
    store: deps.store,
    archive: async ({ registration, operationId, authority, reason }) => {
      const row = registration.binding
        ? await inventory.rowFor(registration.binding, registration.provider)
        : null
      const host = deps.organization()
      if (!row || !host) {
        return {
          status: 'refused',
          opId: operationId,
          refusal: sessionHostRefusal(
            'not-eligible',
            'This computer cannot archive that conversation now. Nothing was changed.'
          )
        }
      }
      return await host.apply({
        kind: 'archive',
        targets: [{ sessionKey: row.viewKey }],
        value: true,
        executor: executorForActor(sessionHostActor(authority)),
        ...(reason ? { reason } : {}),
        opId: operationId
      })
    },
    ask: async ({ registration, authority, operationId, question, timeoutMs }) => {
      const target = await resolveOwnerTarget({ inventory, registration, authority })
      if ('code' in target) {
        return { outcome: 'unsent', reason: target.message }
      }
      const prepared = await prepareHostAsk(
        deps.delivery,
        target,
        { question, ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
        { operationId, conversationId: registration.conversationId },
        { requireCompleteReply: true }
      )
      if (prepared.kind === 'refuse') {
        return { outcome: 'unsent', reason: prepared.refusal.message }
      }
      const settled = await prepared.dispatch()
      if (settled.kind === 'not-delivered') {
        return { outcome: 'unsent', reason: settled.refusal.message }
      }
      if (settled.kind === 'unconfirmed') {
        return { outcome: 'failed', reason: settled.detail }
      }
      const result = settled.result as { outcome?: string; reply?: unknown; failure?: string }
      return result.outcome === 'answered' && typeof result.reply === 'string'
        ? { outcome: 'answered', reply: result.reply }
        : { outcome: 'failed', reason: result.failure ?? 'No complete reply came back.' }
    }
  }
}
