/**
 * What happens after a delivery is handed over: the queue entry is followed to `typed`, the agent
 * to `working` and then `done`; a respawn is recorded write-once and followed the same way.
 */

import { randomBytes } from 'node:crypto'
import { parseSessionReference } from '../../shared/session-reference'
import type { WorkDeliveryReceipt } from './work-delivery-api'
import {
  RENEW_MS,
  WORK_DELIVERY_WORKING_GRACE_MS,
  WorkDeliveryHold,
  messageOf,
  type Watch,
  type WorkDeliveryDeps,
  type WorkPane
} from './work-delivery-claimer-types'
import {
  isAlreadyDelivered,
  type ClaimableDelivery,
  type WorkDeliveryHeldReason,
  type WorkDeliveryKindAdapter,
  type WorkDeliveryOwner,
  type WorkDeliveryTarget
} from './work-delivery-kind'
import { settleDelivered, transcriptProof } from './work-delivery-proof'
import {
  followLoginCut,
  followWorking,
  readFinishedTurn,
  turnFinishedUnseen
} from './work-delivery-turn-follow'

export type ClaimerLedger = {
  deps: WorkDeliveryDeps
  watching: Map<string, Watch>
  receipt(
    hostId: string,
    delivery: ClaimableDelivery,
    receipt: WorkDeliveryReceipt
  ): Promise<boolean>
  hold(
    hostId: string,
    delivery: ClaimableDelivery,
    reason: WorkDeliveryHeldReason,
    message: string
  ): Promise<void>
}

export async function respawnDelivery(
  ledger: ClaimerLedger,
  hostId: string,
  adapter: WorkDeliveryKindAdapter,
  delivery: ClaimableDelivery,
  target: WorkDeliveryTarget
): Promise<void> {
  const brief = adapter.respawnBrief?.(delivery, target) ?? adapter.text(delivery, target)
  // Why: OmniOS records each launch attempt (step claimed) before it starts. A desktop that dies
  // mid-launch leaves it there, so the next claim holds instead of starting a second session.
  // Only an attempt refused before the spawn (step not_started) is replaced by a new one.
  const operationId = `${Date.now()}-${randomBytes(16).toString('hex')}`
  const respawnedRef = `op:${operationId}`
  if (
    !(await ledger.receipt(hostId, delivery, { state: 'claimed', step: 'claimed', respawnedRef }))
  ) {
    const message = 'OmniOS did not record the fresh start, so none was started; it is retried.'
    return ledger.hold(hostId, delivery, 'error', message)
  }
  let started: Awaited<ReturnType<WorkDeliveryDeps['respawn']>>
  try {
    started = await ledger.deps.respawn(delivery, target, brief, operationId)
  } catch (error) {
    if (!(error instanceof WorkDeliveryHold)) {
      // Why: the launch may have started a session, so it is never retried.
      return ledger.hold(hostId, delivery, 'unverifiable', messageOf(error))
    }
    ledger.deps.audit(delivery, `held (${error.reason}), nothing started: ${error.message}`)
    await ledger.receipt(hostId, delivery, {
      state: 'held',
      step: 'not_started',
      heldReason: error.reason,
      detail: { message: error.message.slice(0, 500) }
    })
    return
  }
  const provider =
    parseSessionReference(started.ref)?.agent ??
    parseSessionReference(target.ref)?.agent ??
    delivery.owner?.provider
  const accountId = target.accountId ?? delivery.owner?.accountId
  const folder = started.folder ?? target.folder
  const owner: Partial<WorkDeliveryOwner> = {
    hostId,
    hostLabel: ledger.deps.hostLabel,
    paneKey: started.paneKey,
    title: started.title,
    ...(provider ? { provider } : {}),
    ...(accountId ? { accountId } : {}),
    ...(started.conversationId ? { conversationId: started.conversationId } : {}),
    ...(target.model ? { model: target.model } : {}),
    ...(target.effort ? { effort: target.effort } : {}),
    ...(folder ? { folder } : {})
  }
  const recorded = await ledger.receipt(hostId, delivery, {
    state: 'typed',
    step: 'respawned',
    respawnedRef,
    ...(started.conversationId ? { owner } : {})
  })
  ledger.deps.audit(
    delivery,
    `started one fresh session in pane ${started.paneKey}${recorded ? '' : ' (OmniOS did not record it yet)'}`
  )
  watchDelivery(ledger, delivery, target, started, null, 'typed', true, null)
}

export function watchDelivery(
  ledger: ClaimerLedger,
  delivery: ClaimableDelivery,
  target: WorkDeliveryTarget,
  pane: WorkPane,
  queueId: string | null,
  phase: Watch['phase'],
  started = false,
  turnBefore?: string | null
) {
  const now = ledger.deps.now()
  ledger.watching.set(delivery.key, {
    delivery,
    target,
    pane,
    queueId,
    phase,
    since: now,
    handedAt: now,
    loginCut: null,
    renewedAt: now,
    started,
    freeSince: null,
    ...(turnBefore !== undefined ? { turnBefore } : {})
  })
}

/** Sent → `typed`; turn in flight → `working`; free twice → `done`; leases renewed while waiting. */
export async function followUpDeliveries(ledger: ClaimerLedger): Promise<void> {
  const hostId = ledger.deps.hostId()
  if (!hostId) {
    return
  }
  for (const [key, watch] of ledger.watching) {
    const now = ledger.deps.now()
    if (watch.phase === 'queued' && watch.queueId) {
      // Read before the queue: a turn that finished after this reading is the delivery's own.
      const turnNow = await readFinishedTurn(ledger.deps, watch.pane)
      const state = ledger.deps.queueState(watch.pane, watch.queueId)
      if (state === 'delivered') {
        await ledger.receipt(hostId, watch.delivery, { state: 'typed' })
        watch.phase = 'typed'
        watch.since = now
        watch.renewedAt = now
        watch.freeSince = null
      } else if (state === 'failed-unsent') {
        ledger.watching.delete(key)
        await ledger.receipt(hostId, watch.delivery, {
          state: 'released',
          detail: { message: 'not sent; offered again' }
        })
        continue
      } else if (state !== 'queued') {
        if (await settledByTranscript(ledger, hostId, watch, false)) {
          continue
        }
        await ledger.hold(
          hostId,
          watch.delivery,
          'unverifiable',
          'Whether the session received it cannot be confirmed, so it is not sent a second time.'
        )
        continue
      } else if (now - watch.since > WORK_DELIVERY_WORKING_GRACE_MS) {
        // The entry stays queued; a later claim sees step `queued` and only follows it up.
        await ledger.hold(
          hostId,
          watch.delivery,
          'busy',
          'Queued behind a turn that has not finished in 10 minutes.'
        )
        continue
      } else if (turnNow) {
        // Still waiting: the turn ahead of it finishing is not this delivery's turn.
        watch.turnBefore = turnNow
      }
    }
    if (watch.phase !== 'queued' && (await followLoginCut(ledger, hostId, key, watch, now))) {
      continue
    }
    if (watch.phase === 'working') {
      await followWorking(ledger, hostId, key, watch, now)
      continue
    }
    if (watch.phase === 'typed') {
      const busy = await ledger.deps.busy(watch.pane)
      if (busy === true) {
        await ledger.receipt(hostId, watch.delivery, { state: 'working' })
        ledger.deps.audit(watch.delivery, `working in pane ${watch.pane.paneKey}`)
        watch.phase = 'working'
        watch.since = now
        watch.freeSince = null
        continue
      }
      if (busy === false && (await turnFinishedUnseen(ledger, watch, now))) {
        // Why: a turn shorter than one pass is never seen busy, but its finished turn is new.
        ledger.watching.delete(key)
        await ledger.receipt(hostId, watch.delivery, { state: 'working' })
        await ledger.receipt(hostId, watch.delivery, { state: 'done' })
        ledger.deps.audit(watch.delivery, `done in pane ${watch.pane.paneKey} (a short turn)`)
        continue
      }
      if (busy !== false) {
        watch.freeSince = null
      }
      if (now - watch.since > WORK_DELIVERY_WORKING_GRACE_MS) {
        if (await settledByTranscript(ledger, hostId, watch, true)) {
          continue
        }
        await ledger.hold(
          hostId,
          watch.delivery,
          'unverifiable',
          'It was sent, but the agent never showed it working on it.'
        )
        continue
      }
    }
    if (now - watch.renewedAt > RENEW_MS) {
      watch.renewedAt = now
      await ledger.receipt(hostId, watch.delivery, {
        state: watch.phase === 'typed' ? 'typed' : 'claimed'
      })
    }
  }
}

/** Its text found as a user turn in the transcript: done, instead of held as unconfirmable. */
async function settledByTranscript(
  ledger: ClaimerLedger,
  hostId: string,
  watch: Watch,
  typedAlready: boolean
): Promise<boolean> {
  const proof = await transcriptProof(ledger.deps, watch.delivery, watch.target)
  if (!proof) {
    return false
  }
  const summary = `done in pane ${watch.pane.paneKey} (${proof})`
  await settleDelivered(ledger, hostId, watch.delivery, summary, typedAlready)
  return true
}

/** Whether delivering would unarchive, restore, resume or respawn (unknown counts as yes). */
export async function needsStart(
  deps: WorkDeliveryDeps,
  delivery: ClaimableDelivery
): Promise<boolean> {
  try {
    const target = await deps.resolveTarget(deps.adapters.get(delivery.kind)!, delivery)
    if (!target || isAlreadyDelivered(target)) {
      return false
    }
    if (target.deleted) {
      return true
    }
    const holder = await deps.findHolder(target)
    return holder.kind === 'none' || (holder.kind === 'live' && holder.pane.archived)
  } catch {
    return true
  }
}

export async function loginBlocks(
  deps: WorkDeliveryDeps,
  target: WorkDeliveryTarget
): Promise<string | null> {
  if (!deps.loginReady) {
    return null
  }
  try {
    const login = await deps.loginReady(target)
    return login.ready
      ? null
      : (login.reason ?? 'The account this session runs on is not signed in.')
  } catch (error) {
    return `Whether its account is signed in could not be read: ${messageOf(error)}`
  }
}
