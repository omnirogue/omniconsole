/**
 * Hook-first routing for work deliveries (answerDelivery.hookFirst): an answer for a Claude/Codex
 * conversation on this computer waits in the answer inbox instead of being typed. A working agent
 * takes it at PostToolUse/Stop; an idle one gets one fixed wake line and takes it at
 * UserPromptSubmit; a resumed one at SessionStart, once bound to the pane and launch the resume
 * opened. It is bound only while the pane keeps the owner its lookup saw. Not taken in time, or its
 * one hook copy unacknowledged or unconfirmed, it goes to today's typed path unchanged (once). The claimer sees an ordinary queue entry: `queued`, then `delivered` once the
 * conversation reports a later step. Off, every call goes straight to the wrapped deps and any
 * answer still waiting is handed to the typed path.
 */

import type { AnswerDeliveryPilotRecord } from '../../shared/answer-delivery-pilot-report'
import type { WorkDeliveryReceipt } from '../work-delivery/work-delivery-api'
import {
  workDeliveryQueueId,
  type QueueEntryState,
  type WorkDeliveryDeps,
  type WorkPane
} from '../work-delivery/work-delivery-claimer-types'
import type { ClaimableDelivery, WorkDeliveryTarget } from '../work-delivery/work-delivery-kind'
import type { AnswerInbox, AnswerItem, HolderIdentity } from './answer-inbox'
import { answerFitsHookReply, compactAnswerFor } from './answer-inbox-render'
import {
  enqueueWakeLine,
  reconcileTypedSend,
  typeHookFirstRoute,
  type HookFirstFallbackContext
} from './hook-first-fallback'
import { HookFirstHolders, resumeThenBind } from './hook-first-holder'
import {
  auditWhileWaiting,
  heldWhileWaiting,
  hookFirstTickStep,
  localConversation,
  newRoute,
  pilotRecord,
  receiptWithPath,
  restoredSnapshot,
  wakeQueueId,
  type HookFirstRoute,
  type HookFirstSnapshot
} from './hook-first-route'

export type HookFirstRouterOptions = {
  inbox: AnswerInbox
  enabled(): boolean
  now?(): number
  log?(record: AnswerDeliveryPilotRecord): void
  /** `urgent`: save now (a handoff the next start must see); else whenever convenient. */
  onChange?(urgent: boolean): void
  /** Takes back a still-queued prompt-queue entry (a wake line no longer needed). */
  cancelQueued?(pane: WorkPane, id: string): void
  /** The launch recorded for the pane and its proven agent pid; null when none is recorded. */
  holderIdentity?(pane: WorkPane): Promise<HolderIdentity | null>
}

export class HookFirstRouter {
  private readonly routes = new Map<string, HookFirstRoute>()
  /** Typed fallbacks mid-enqueue in this process (a restored `fallback_sending` is not one). */
  private readonly typing = new Set<string>()
  /** Restored from disk and not yet reconciled with the prompt queue. */
  private readonly restored = new Set<string>()
  private inner: WorkDeliveryDeps | null = null
  private readonly holders: HookFirstHolders

  constructor(private readonly options: HookFirstRouterOptions) {
    this.holders = new HookFirstHolders(options.holderIdentity)
  }

  private get inbox(): AnswerInbox {
    return this.options.inbox
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private changed(urgent = false): void {
    this.options.onChange?.(urgent)
  }

  route(id: string): HookFirstRoute | undefined {
    return this.routes.get(id)
  }

  private waits(key: string): boolean {
    return this.routes.get(workDeliveryQueueId(key))?.phase === 'hook'
  }

  wrap(inner: WorkDeliveryDeps): WorkDeliveryDeps {
    this.inner = inner
    return {
      ...inner,
      api: {
        ...inner.api,
        receipt: (key, hostId, receipt) => {
          const reported = this.withPath(key, receipt)
          return inner.api.receipt(
            key,
            hostId,
            this.waits(key) ? heldWhileWaiting(reported) : reported
          )
        }
      },
      audit: (delivery, summary) =>
        inner.audit(delivery, this.waits(delivery.key) ? auditWhileWaiting(summary) : summary),
      findHolder: this.holders.findHolder(
        inner,
        () => this.options.enabled() || this.routes.size > 0
      ),
      resume: resumeThenBind(inner, this.holders, {
        offer: (delivery, target) => this.offer(delivery, target, null),
        bind: (route, identity) => this.inbox.bind(route.id, identity),
        drop: (route) => this.drop(route)
      }),
      enqueue: (pane, target, id, text, delivery) =>
        this.enqueue(inner, pane, target, id, text, delivery),
      queueState: (pane, id) => this.queueState(inner, pane, id)
    }
  }

  private offer(
    delivery: ClaimableDelivery,
    target: WorkDeliveryTarget,
    holder: { pane: WorkPane; identity: HolderIdentity } | null,
    text?: string
  ): HookFirstRoute | null {
    const conversation = this.options.enabled() ? localConversation(target) : null
    const body = text ?? this.inner?.adapters.get(delivery.kind)?.text(delivery, target)
    const compact = compactAnswerFor(delivery)
    if (!conversation || !body || !answerFitsHookReply(body, compact)) {
      return null
    }
    const id = workDeliveryQueueId(delivery.key)
    const existing = this.routes.get(id)
    if (existing?.phase === 'hook') {
      return existing
    }
    if (existing && existing.phase !== 'fallback_failed') {
      return null
    }
    const item = this.inbox.offer(conversation, {
      id,
      deliveryKey: delivery.key,
      text: body,
      compact,
      holder: holder?.identity ?? null
    })
    // Why claimedAt: a retry after a failed typed send is the same delivery in the pilot log.
    const route = newRoute(
      { id, delivery, target, conversation, text: body, pane: holder?.pane ?? null },
      existing?.claimedAt ?? item.offeredAt
    )
    this.routes.set(id, route)
    this.record(route, 'open')
    this.changed(true)
    return route
  }

  private async enqueue(
    inner: WorkDeliveryDeps,
    pane: WorkPane,
    target: WorkDeliveryTarget,
    id: string,
    text: string,
    delivery?: ClaimableDelivery
  ): Promise<boolean> {
    const held = this.routes.get(id)?.phase === 'hook' ? this.routes.get(id)! : null
    const check =
      held || this.options.enabled()
        ? await this.holders.check(inner, target, pane, held?.delivery ?? delivery)
        : null
    if (check?.kind === 'changed') {
      // Why: the pane changed owner since the lookup; neither path may reach the replacement.
      if (held) {
        this.drop(held)
      }
      return false
    }
    // Why: a hook proves itself against the launch recorded for the pane; none recorded, no hook.
    const identity = check?.kind === 'bind' ? check.identity : null
    const route =
      held ?? (delivery && identity ? this.offer(delivery, target, { pane, identity }, text) : null)
    if (route && !identity) {
      this.drop(route)
    }
    if (!route || !identity) {
      return inner.enqueue(pane, target, id, text, delivery)
    }
    route.pane = pane
    this.inbox.bind(id, identity)
    if (this.inbox.get(id)?.state === 'confirmed' || route.handedAt !== null) {
      return true
    }
    const busy = await inner.busy(pane).catch(() => null)
    if (busy === false) {
      // Why: an idle agent takes no step on its own; one short line wakes it, its prompt hook carries the answer.
      let woke: boolean
      try {
        woke = await enqueueWakeLine(inner, pane, target, id)
      } catch (error) {
        this.drop(route)
        throw error
      }
      if (!woke) {
        this.drop(route)
        return false
      }
    }
    route.mode = busy === false ? 'woken' : 'working'
    route.handedAt = this.now()
    inner.audit(route.delivery, `waiting for a hook of pane ${pane.paneKey} (${route.mode})`)
    this.changed(true)
    return true
  }

  private queueState(inner: WorkDeliveryDeps, pane: WorkPane, id: string): QueueEntryState {
    const route = this.routes.get(id)
    if (route && this.restored.delete(id) && !this.typing.has(id)) {
      // Why: a crash can land before the handoff or the queue's own save; the queue says which.
      if (route.phase === 'fallback_sending' || (route.phase === 'fallback' && !route.reported)) {
        reconcileTypedSend(route, inner.queueState(pane, id))
        this.changed(true)
      }
    }
    switch (route?.phase) {
      case 'hook':
        return this.inbox.get(id)?.state === 'confirmed' ? 'delivered' : 'queued'
      case 'fallback_sending':
        return 'queued'
      case 'fallback_failed':
        return 'failed-unsent'
      case 'fallback':
      case undefined:
        // Typed (or never routed): the prompt queue owns it.
        return inner.queueState(pane, id)
    }
  }

  private withPath(key: string, receipt: WorkDeliveryReceipt): WorkDeliveryReceipt {
    const route = this.routes.get(workDeliveryQueueId(key))
    const reported = route && receiptWithPath(route, this.inbox.get(route.id), receipt, this.now())
    if (!route || !reported) {
      return receipt
    }
    route.reported = true
    this.changed(true)
    return reported
  }

  /** The inbox changed an item: a confirmation is logged once; a carried answer needs no wake line. */
  noteItemChange(item: AnswerItem): void {
    const route = this.routes.get(item.id)
    if (route && (item.state === 'injected' || item.state === 'confirmed')) {
      this.cancelWake(route)
    }
    if (route && item.state === 'confirmed' && !route.logged) {
      this.record(route, 'confirmed', item)
    }
    // Why urgent: a hand-out and its outcome (a spent Stop block, an unacknowledged reply) must
    // survive a crash, or a restart would hand the answer out again as if new.
    this.changed(true)
  }

  private cancelWake(route: HookFirstRoute): void {
    if (route.mode === 'woken' && route.pane && !route.wakeCancelled) {
      route.wakeCancelled = true
      this.options.cancelQueued?.(route.pane, wakeQueueId(route.id))
    }
  }

  /**
   * Re-offers stale injections, types late items, forgets old settled ones. Off, only answers
   * never injected are typed; injected ones keep waiting for their confirmation.
   */
  async tick(): Promise<void> {
    const enabled = this.options.enabled()
    if (enabled) {
      this.inbox.reofferStale()
    }
    const now = this.now()
    for (const route of this.routes.values()) {
      const step = hookFirstTickStep(route, this.inbox.get(route.id), now, enabled)
      if (step === 'forget') {
        this.routes.delete(route.id)
        this.inbox.forget(route.id)
        this.changed()
      } else if (step === 'drop') {
        this.drop(route)
      } else if (step === 'type') {
        await this.type(route)
      }
    }
  }

  private async type(route: HookFirstRoute): Promise<void> {
    if (!this.inner) {
      return
    }
    const context: HookFirstFallbackContext = {
      inbox: this.inbox,
      inner: this.inner,
      now: () => this.now(),
      record: (target, outcome, item) => this.record(target, outcome, item),
      changed: (urgent) => this.changed(urgent),
      cancelWake: (target) => this.cancelWake(target)
    }
    this.typing.add(route.id)
    try {
      await typeHookFirstRoute(context, route)
    } finally {
      this.typing.delete(route.id)
    }
  }

  private drop(route: HookFirstRoute): void {
    const item = this.inbox.withdraw(route.id)
    this.routes.delete(route.id)
    this.record(route, 'withdrawn', item ?? undefined)
    this.changed(true)
  }

  private record(
    route: HookFirstRoute,
    outcome: AnswerDeliveryPilotRecord['outcome'],
    item = this.inbox.get(route.id)
  ): void {
    if (outcome !== 'open') {
      route.logged = true
    }
    this.options.log?.(pilotRecord(route, outcome, item))
  }

  snapshot(): HookFirstSnapshot {
    return { routes: [...this.routes.values()], items: this.inbox.all() }
  }

  restore(snapshot: HookFirstSnapshot): void {
    const restored = restoredSnapshot(snapshot, this.now())
    for (const route of restored.routes) {
      this.routes.set(route.id, route)
      this.restored.add(route.id)
    }
    for (const item of restored.items) {
      this.inbox.restore(item)
    }
  }
}
