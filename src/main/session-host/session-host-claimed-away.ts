/**
 * A review decision woke this computer's sleeping conversation on another computer while this one
 * was off (OAOS-12 Phase 2; OmniOS's wake claim is the handover). This computer records it as
 * relinquished to that computer, exactly as relocate's source does, so every path that reads
 * `relocatedAwayIn` (resume, restart, adoption) never runs it here again.
 */

import { randomUUID } from 'node:crypto'
import {
  sessionHostConversationId,
  type SessionHostProviderIdentity
} from '../../shared/session-host-identity'
import type { SessionHostAdmissionStore } from './session-host-admission-store'
import type { SessionHostRegistration } from './session-host-journal'

export type ClaimedAwayResult = { status: 'ok' } | { status: 'refused'; reason: string }

export async function yieldSessionHostConversationToClaim(
  store: SessionHostAdmissionStore,
  input: {
    provider: SessionHostProviderIdentity
    toHostId: string
    /** The claim's own id (page and decision): one grant per claim, so a retry changes nothing. */
    claimId: string
    /** The wake copy's checksum, recorded where relocate records its manifest digest. */
    digest: string
  }
): Promise<ClaimedAwayResult> {
  const self = store.host.incarnation
  const grantId = `wake-claim:${input.claimId}`
  return await store.mutate<ClaimedAwayResult>(async (journal) => {
    if (journal.grants[`issued:${grantId}`]) {
      return { value: { status: 'ok' }, changed: false }
    }
    const same = Object.values(journal.conversations).filter(
      (registration) =>
        registration.provider.agent === input.provider.agent &&
        registration.provider.sessionId === input.provider.sessionId
    )
    // Why refuse: another live process of this account runs it; it is not this pass's to stop.
    const running = same.find(
      (registration) =>
        registration.owned &&
        registration.controller !== null &&
        registration.controller !== self &&
        registration.controller in journal.controllers
    )
    if (running) {
      return {
        value: { status: 'refused', reason: 'another OmniConsole process here runs it' },
        changed: false
      }
    }
    const at = store.now()
    const owned = same.filter((registration) => registration.owned)
    const registration: SessionHostRegistration =
      owned[0] ??
      (() => {
        const created: SessionHostRegistration = {
          conversationId: sessionHostConversationId(randomUUID()),
          hostId: store.host.hostId,
          ownerEpoch: 1,
          provider: input.provider,
          processIncarnation: null,
          adopted: false,
          owned: true,
          controller: self,
          binding: null,
          workspace: null,
          registeredAt: at
        }
        journal.conversations[created.conversationId] = created
        return created
      })()
    for (const other of owned) {
      other.owned = false
    }
    registration.owned = false
    registration.relinquishment = {
      conversationId: registration.conversationId,
      hostId: store.host.hostId,
      relinquishedEpoch: registration.ownerEpoch,
      grantId,
      at
    }
    journal.grants[`issued:${grantId}`] = {
      grant: {
        grantId,
        relocation: grantId,
        conversationId: registration.conversationId,
        fromHostId: store.host.hostId,
        toHostId: input.toHostId,
        ownerEpoch: registration.ownerEpoch + 1,
        provider: input.provider,
        manifestDigest: input.digest,
        issuedAt: at
      },
      role: 'issued',
      at
    }
    return { value: { status: 'ok' }, changed: true }
  })
}
