/**
 * The host inventory's ownership half: which conversations this execution account owns, which of
 * its processes runs each, and the only way ownership ever moves, a relocation grant. Nothing here
 * reassigns a conversation because a host went quiet.
 */

import { randomUUID } from 'node:crypto'
import type { ConversationSource } from '../../shared/conversation-source'
import {
  sessionHostConversationId,
  sessionHostGrantMismatch,
  type SessionHostOwnershipGrant,
  type SessionHostProviderIdentity
} from '../../shared/session-host-identity'
import { sessionHostRefusal, type SessionHostRefusal } from '../../shared/session-host-refusal'
import type { SessionHostAdmissionStore } from './session-host-admission-store'
import type {
  SessionHostJournal,
  SessionHostRegistration,
  SessionHostWorkspace
} from './session-host-journal'

export type SessionHostRegistryResult =
  | { status: 'ok'; registration: SessionHostRegistration }
  | { status: 'refused'; refusal: SessionHostRefusal }

export type SessionHostRelinquishResult =
  | { status: 'ok'; grant: SessionHostOwnershipGrant }
  | { status: 'refused'; refusal: SessionHostRefusal }

export type SessionHostRegisterInput = {
  provider: SessionHostProviderIdentity
  binding: ConversationSource | null
  workspace: SessionHostWorkspace | null
  processIncarnation: string | null
  /** True only when the caller verified ownership (package B's adoption evidence). */
  adopted: boolean
}

const conflict = (message: string): SessionHostRegistryResult => ({
  status: 'refused',
  refusal: sessionHostRefusal('ownership-conflict', `${message} Nothing was changed.`)
})

function liveOtherController(
  journal: SessionHostJournal,
  registration: SessionHostRegistration,
  self: string
): boolean {
  const controller = registration.controller
  return controller !== null && controller !== self && controller in journal.controllers
}

/** Its own panes' key for a conversation; presentation only, so it is matched, never trusted. */
export function findSessionHostRegistration(
  journal: SessionHostJournal,
  source: ConversationSource
): SessionHostRegistration | null {
  return (
    Object.values(journal.conversations).find(
      (registration) =>
        registration.owned &&
        registration.binding?.worktreeId === source.worktreeId &&
        registration.binding.paneKey === source.paneKey &&
        (source.kind !== 'structured' || registration.binding.sessionId === source.sessionId)
    ) ?? null
  )
}

/**
 * One registration per provider identity. Registering an existing one refreshes its bindings and
 * takes control of it only when no other live process runs it (a restart's verified re-adoption).
 */
export async function registerSessionHostConversation(
  store: SessionHostAdmissionStore,
  input: SessionHostRegisterInput
): Promise<SessionHostRegistryResult> {
  const self = store.host.incarnation
  return await store.mutate<SessionHostRegistryResult>(async (journal) => {
    const same = Object.values(journal.conversations).filter(
      (registration) =>
        registration.owned &&
        registration.provider.agent === input.provider.agent &&
        registration.provider.sessionId === input.provider.sessionId
    )
    if (same.length > 1) {
      return {
        value: conflict('This computer has conflicting records for that session.'),
        changed: false
      }
    }
    const at = store.now()
    const existing = same[0]
    if (existing) {
      if (liveOtherController(journal, existing, self)) {
        return {
          value: conflict('Another OmniConsole process on this computer runs that session.'),
          changed: false
        }
      }
      Object.assign(existing, {
        controller: self,
        binding: input.binding,
        workspace: input.workspace,
        processIncarnation: input.processIncarnation,
        ...(input.adopted && !existing.adopted ? { adopted: true, adoptedAt: at } : {})
      })
      return { value: { status: 'ok', registration: existing }, changed: true }
    }
    const registration: SessionHostRegistration = {
      conversationId: sessionHostConversationId(randomUUID()),
      hostId: store.host.hostId,
      ownerEpoch: 1,
      provider: input.provider,
      processIncarnation: input.processIncarnation,
      adopted: input.adopted,
      owned: true,
      controller: self,
      binding: input.binding,
      workspace: input.workspace,
      registeredAt: at,
      ...(input.adopted ? { adoptedAt: at } : {})
    }
    journal.conversations[registration.conversationId] = registration
    return { value: { status: 'ok', registration }, changed: true }
  })
}

/**
 * The source's half of relocation: in one durable step it stops owning the conversation at this
 * epoch and issues a grant for exactly one destination and the next epoch. Idempotent per grant id.
 */
export async function relinquishSessionHostConversation(
  store: SessionHostAdmissionStore,
  input: {
    conversationId: string
    grantId: string
    relocation: string
    toHostId: string
    manifestDigest: string
  }
): Promise<SessionHostRelinquishResult> {
  return await store.mutate<SessionHostRelinquishResult>(async (journal) => {
    const issued = journal.grants[`issued:${input.grantId}`]
    if (issued) {
      return { value: { status: 'ok', grant: issued.grant }, changed: false }
    }
    const registration = journal.conversations[input.conversationId]
    if (!registration?.owned || registration.controller !== store.host.incarnation) {
      return {
        value: {
          status: 'refused',
          refusal: sessionHostRefusal(
            'not-owner',
            'This process does not run that conversation, so it cannot hand it over. Nothing was changed.'
          )
        },
        changed: false
      }
    }
    const at = store.now()
    const grant: SessionHostOwnershipGrant = {
      grantId: input.grantId,
      relocation: input.relocation,
      conversationId: input.conversationId,
      fromHostId: store.host.hostId,
      toHostId: input.toHostId,
      ownerEpoch: registration.ownerEpoch + 1,
      provider: registration.provider,
      manifestDigest: input.manifestDigest,
      issuedAt: at
    }
    registration.owned = false
    registration.relinquishment = {
      conversationId: input.conversationId,
      hostId: store.host.hostId,
      relinquishedEpoch: registration.ownerEpoch,
      grantId: input.grantId,
      at
    }
    journal.grants[`issued:${input.grantId}`] = { grant, role: 'issued', at }
    return { value: { status: 'ok', grant }, changed: true }
  })
}

/**
 * The destination's half: consumed durably and exactly once, then this host owns the next epoch.
 * `consumer` (the resuming operation) makes the use exclusive: a second operation presenting the
 * same grant is refused rather than answered as a repeat, so it can never start a second copy.
 */
export async function consumeSessionHostGrant(
  store: SessionHostAdmissionStore,
  grant: SessionHostOwnershipGrant,
  place: {
    binding: ConversationSource | null
    workspace: SessionHostWorkspace | null
    processIncarnation: string | null
  },
  consumer?: string
): Promise<SessionHostRegistryResult> {
  return await store.mutate<SessionHostRegistryResult>(async (journal) => {
    const invalid = (message: string) => ({
      value: {
        status: 'refused' as const,
        refusal: sessionHostRefusal('grant-invalid', `${message} Nothing was changed.`)
      },
      changed: false
    })
    const consumed = journal.grants[`consumed:${grant.grantId}`]
    if (consumed) {
      const registration = journal.conversations[grant.conversationId]
      return JSON.stringify(consumed.grant) === JSON.stringify(grant) &&
        registration &&
        (consumer === undefined || consumed.consumer === consumer)
        ? { value: { status: 'ok' as const, registration }, changed: false }
        : invalid('That grant was already used.')
    }
    const existing = journal.conversations[grant.conversationId]
    const mismatch = sessionHostGrantMismatch(grant, {
      hostId: store.host.hostId,
      conversationId: grant.conversationId,
      knownEpoch: existing?.ownerEpoch ?? null
    })
    if (mismatch) {
      return invalid(mismatch)
    }
    const at = store.now()
    const registration: SessionHostRegistration = {
      conversationId: grant.conversationId,
      hostId: store.host.hostId,
      ownerEpoch: grant.ownerEpoch,
      provider: grant.provider,
      processIncarnation: place.processIncarnation,
      adopted: true,
      owned: true,
      controller: store.host.incarnation,
      binding: place.binding,
      workspace: place.workspace,
      registeredAt: existing?.registeredAt ?? at,
      adoptedAt: at
    }
    journal.conversations[grant.conversationId] = registration
    journal.grants[`consumed:${grant.grantId}`] = {
      grant,
      role: 'consumed',
      at,
      ...(consumer !== undefined ? { consumer } : {})
    }
    return { value: { status: 'ok' as const, registration }, changed: true }
  })
}
