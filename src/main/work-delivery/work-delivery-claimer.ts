/**
 * The claiming computer's pass for work deliveries: claim one record from OmniOS with a lease,
 * find the owner's conversation and get the text into it, then report what happened.
 *
 * Order, for every kind: a live pane gets the text through its prompt queue (unarchived first when
 * it is archived); no live pane → the same conversation is resumed (same transcript, account,
 * folder, model and effort); its transcript gone → one fresh session with the owner's model and
 * effort and a brief, recorded write-once as `respawned`. A conversation that cannot be verified is
 * never started a second time; a deleted or hidden one is held as `protection`, never bypassed.
 *
 * "Delivered" is a `working` receipt: the queue entry was sent (`typed`) and the agent then showed
 * a turn in flight; `done` follows when it is seen free twice. A `sending` entry stranded by a
 * restart is held `unverifiable`, never replayed.
 *
 * Many deliveries are followed at once; only the steps that start something (unarchive, restore,
 * resume, respawn) go one at a time, each after the previously reopened session is ready.
 */

import type { WorkDeliveryReceipt } from './work-delivery-api'
import {
  MAX_CLAIMS_PER_PASS,
  WorkDeliveryHold,
  heldHere,
  messageOf,
  workDeliveryQueueId,
  type Watch,
  type WorkDeliveryDeps,
  type WorkHolder,
  type WorkPane
} from './work-delivery-claimer-types'
import {
  respawnMayHaveStarted,
  type ClaimableDelivery,
  type WorkDeliveryHeldReason,
  type WorkDeliveryKind,
  type WorkDeliveryTarget
} from './work-delivery-kind'
import {
  followUpDeliveries,
  loginBlocks,
  needsStart,
  respawnDelivery,
  watchDelivery,
  type ClaimerLedger
} from './work-delivery-watch'
import { notSentHold, prepareHandover } from './work-delivery-turn-follow'

export * from './work-delivery-claimer-types'

export class WorkDeliveryClaimer {
  private readonly watching = new Map<string, Watch>()
  private readonly ledger: ClaimerLedger
  private running = false

  constructor(private readonly deps: WorkDeliveryDeps) {
    this.ledger = {
      deps: this.deps,
      watching: this.watching,
      receipt: (hostId, delivery, receipt) => this.receipt(hostId, delivery, receipt),
      hold: (hostId, delivery, reason, message) => this.hold(hostId, delivery, reason, message)
    }
  }

  /** The kinds this desktop has adapters for; OmniOS only offers those. */
  caps(): WorkDeliveryKind[] {
    return [...this.deps.adapters.keys()]
  }

  watched(): string[] {
    return [...this.watching.keys()]
  }

  /** One pass: follow up deliveries already handed over, then claim new ones. */
  async pass(): Promise<void> {
    if (this.running) {
      return
    }
    this.running = true
    try {
      await followUpDeliveries(this.ledger)
      const hostId = this.deps.hostId()
      if (!hostId) {
        return
      }
      const listed = await this.deps.api.claimable(hostId, this.deps.hostLabel, this.caps())
      if (listed.status !== 'ok') {
        return
      }
      let claims = 0
      for (const offered of listed.value) {
        if (claims >= MAX_CLAIMS_PER_PASS) {
          break
        }
        if (!this.deps.adapters.has(offered.kind) || this.watching.has(offered.key)) {
          continue
        }
        // Why before the claim: a computer that does not hold the conversation leaves it alone.
        if (!(await heldHere(this.deps, offered))) {
          continue
        }
        // Why: a reopened session finishes starting before the next one is touched.
        if (this.startPending() && (await needsStart(this.deps, offered))) {
          continue
        }
        const claimed = await this.deps.api.claim(offered.key, hostId, this.deps.hostLabel)
        if (claimed.status !== 'ok') {
          continue
        }
        claims++
        await this.deliver(hostId, claimed.value)
      }
    } finally {
      this.running = false
    }
  }

  private startPending(): boolean {
    return [...this.watching.values()].some((watch) => watch.started && watch.phase !== 'working')
  }

  private async receipt(
    hostId: string,
    delivery: ClaimableDelivery,
    receipt: WorkDeliveryReceipt
  ): Promise<boolean> {
    const sent = await this.deps.api.receipt(delivery.key, hostId, receipt)
    return sent.status === 'ok'
  }

  private async hold(
    hostId: string,
    delivery: ClaimableDelivery,
    reason: WorkDeliveryHeldReason,
    message: string
  ) {
    this.watching.delete(delivery.key)
    this.deps.audit(delivery, `held (${reason}): ${message}`)
    await this.receipt(hostId, delivery, {
      state: 'held',
      heldReason: reason,
      detail: { message: message.slice(0, 500) }
    })
  }

  private async deliver(hostId: string, delivery: ClaimableDelivery): Promise<void> {
    const adapter = this.deps.adapters.get(delivery.kind)!
    let target: WorkDeliveryTarget | null
    try {
      target = await this.deps.resolveTarget(adapter, delivery)
    } catch (error) {
      return error instanceof WorkDeliveryHold
        ? this.hold(hostId, delivery, error.reason, error.message)
        : this.hold(hostId, delivery, 'error', messageOf(error))
    }
    if (!target) {
      return this.hold(
        hostId,
        delivery,
        'not_found',
        'No session is bound to this work on this computer.'
      )
    }
    const queueId = workDeliveryQueueId(delivery.key)
    const handedOver =
      delivery.state === 'typed' || delivery.step === 'queued' || delivery.step === 'peer_sent'
    let restored = false
    if (target.deleted) {
      if (handedOver || respawnMayHaveStarted(delivery)) {
        return this.hold(
          hostId,
          delivery,
          'unverifiable',
          'It was already handed to a session that is no longer open, so it is not sent a second time.'
        )
      }
      if (!adapter.restoreDeleted || !this.deps.restoreDeleted) {
        return this.hold(
          hostId,
          delivery,
          'protection',
          'The person deleted this conversation; it is not brought back without them.'
        )
      }
      const login = await loginBlocks(this.deps, target)
      if (login) {
        return this.hold(hostId, delivery, 'login_failed', login)
      }
      try {
        await this.deps.restoreDeleted(adapter, delivery, target)
      } catch (error) {
        return this.hold(hostId, delivery, 'protection', messageOf(error))
      }
      await this.receipt(hostId, delivery, { state: 'claimed', step: 'restored' })
      target = { ...target, deleted: false }
      restored = true
    }
    const holder: WorkHolder = restored ? { kind: 'none' } : await this.deps.findHolder(target)
    if (holder.kind === 'blocked') {
      return this.hold(hostId, delivery, 'unverifiable', holder.reason)
    }
    // Typed already (a lease that ran out mid-delivery): never type again, only follow it up.
    if (handedOver) {
      if (holder.kind !== 'live') {
        return this.hold(
          hostId,
          delivery,
          'unverifiable',
          'It was already handed to a session that is no longer open, so it is not sent a second time.'
        )
      }
      const state = this.deps.queueState(holder.pane, queueId)
      if (state === 'missing' || state === 'sending' || state === 'failed') {
        return this.hold(
          hostId,
          delivery,
          'unverifiable',
          'Whether the session received it cannot be confirmed, so it is not sent a second time.'
        )
      }
      if (state !== 'failed-unsent') {
        watchDelivery(
          this.ledger,
          delivery,
          target,
          holder.pane,
          queueId,
          state === 'delivered' ? 'typed' : 'queued'
        )
        return
      }
    }
    if (respawnMayHaveStarted(delivery)) {
      // A fresh session already started for this answer: only ever that one.
      if (holder.kind !== 'live') {
        return this.hold(
          hostId,
          delivery,
          'unverifiable',
          'Its fresh session is not open here, so a second one is not started.'
        )
      }
    }
    if (!restored) {
      const login = await loginBlocks(this.deps, target)
      if (login) {
        return this.hold(hostId, delivery, 'login_failed', login)
      }
    }
    let pane: WorkPane
    let started = restored
    if (holder.kind === 'live') {
      pane = holder.pane
      if (pane.archived) {
        try {
          await this.deps.unarchive(pane, `A reply on ${delivery.workItem} needs this session`)
          await this.receipt(hostId, delivery, { state: 'claimed', step: 'unarchived' })
          pane = { ...pane, archived: false }
          started = true
        } catch (error) {
          return this.hold(
            hostId,
            delivery,
            'protection',
            `It could not be unarchived: ${messageOf(error)}`
          )
        }
      }
    } else {
      if (!this.deps.windowAttached()) {
        return this.hold(
          hostId,
          delivery,
          'no_window',
          'It reopens when the OmniConsole window is open on this computer.'
        )
      }
      try {
        pane = await this.deps.resume(target, `A reply on ${delivery.workItem} needs this session`)
        await this.receipt(hostId, delivery, {
          state: 'claimed',
          step: target.archived ? 'unarchived' : 'resumed'
        })
        if (target.archived) {
          await this.receipt(hostId, delivery, { state: 'claimed', step: 'resumed' })
        }
        started = true
      } catch (error) {
        if (!(error instanceof WorkDeliveryHold)) {
          // Something may have started: never retried automatically, never a second copy.
          return this.hold(hostId, delivery, 'unverifiable', messageOf(error))
        }
        if (error.reason !== 'transcript_gone' || adapter.noRespawn) {
          return this.hold(hostId, delivery, error.reason, error.message)
        }
        return respawnDelivery(this.ledger, hostId, adapter, delivery, {
          ...target,
          transcript: 'gone'
        })
      }
    }
    const turnBefore = await prepareHandover(this.deps, pane, started)
    if (holder.kind === 'live' && adapter.deliverLive && this.deps.deliverLive) {
      let live: 'typed' | 'not_open'
      try {
        live = await this.deps.deliverLive(adapter, delivery, target, pane)
      } catch (error) {
        // Something may have been typed: never retried blind, unless the adapter says why not.
        return error instanceof WorkDeliveryHold
          ? this.hold(hostId, delivery, error.reason, error.message)
          : this.hold(hostId, delivery, 'unverifiable', messageOf(error))
      }
      if (live === 'typed') {
        await this.receipt(hostId, delivery, { state: 'typed' })
        this.deps.audit(
          delivery,
          `typed into the open prompt in pane ${pane.paneKey} (“${pane.title}”)`
        )
        watchDelivery(this.ledger, delivery, target, pane, null, 'typed', started, turnBefore)
        return
      }
    }
    const text = adapter.text(delivery, target)
    let queued: boolean
    try {
      queued = await this.deps.enqueue(pane, target, queueId, text)
    } catch (error) {
      return this.hold(hostId, delivery, 'error', messageOf(error))
    }
    if (!queued) {
      return this.hold(hostId, delivery, ...notSentHold(started))
    }
    await this.receipt(hostId, delivery, { state: 'claimed', step: 'queued' })
    this.deps.audit(delivery, `queued in pane ${pane.paneKey} (“${pane.title}”)`)
    watchDelivery(this.ledger, delivery, target, pane, queueId, 'queued', started, turnBefore)
  }
}
