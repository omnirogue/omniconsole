/**
 * Handing an answer no hook took to today's typed path. It is typed only into the pane that still
 * holds its conversation, and the handoff is saved before the enqueue so a restart reconciles it
 * with the real prompt queue instead of offering it again beside a typed copy.
 */

import type { AnswerDeliveryPilotRecord } from '../../shared/answer-delivery-pilot-report'
import type {
  QueueEntryState,
  WorkDeliveryDeps,
  WorkPane
} from '../work-delivery/work-delivery-claimer-types'
import type { AnswerInbox, AnswerItem } from './answer-inbox'
import type { WorkDeliveryTarget } from '../work-delivery/work-delivery-kind'
import { HOOK_FIRST_WAKE_LINE, wakeQueueId, type HookFirstRoute } from './hook-first-route'

export type HookFirstFallbackContext = {
  inbox: AnswerInbox
  inner: WorkDeliveryDeps
  now(): number
  record(
    route: HookFirstRoute,
    outcome: AnswerDeliveryPilotRecord['outcome'],
    item?: AnswerItem
  ): void
  /** `urgent` saves the routes before returning. */
  changed(urgent?: boolean): void
  cancelWake(route: HookFirstRoute): void
}

/** Types an answer still offered (never one a hook carried) into the pane holding its conversation. */
export async function typeHookFirstRoute(
  context: HookFirstFallbackContext,
  route: HookFirstRoute
): Promise<void> {
  const { inbox, inner } = context
  const pane = route.pane
  if (!pane) {
    return
  }
  const holder = await inner.findHolder(route.target).catch(() => null)
  const item = inbox.get(route.id)
  if (route.phase !== 'hook' || item?.state !== 'offered') {
    // A hook took it while the holder was read.
    return
  }
  inbox.withdraw(route.id)
  if (holder?.kind !== 'live' || holder.pane.paneKey !== pane.paneKey) {
    // Why: the pane no longer runs this conversation, so typing would reach another one.
    route.phase = 'fallback_failed'
    route.fallbackAt = context.now()
    inner.audit(
      route.delivery,
      `not typed: pane ${pane.paneKey} no longer holds this conversation; offered again`
    )
    context.changed(true)
    return
  }
  route.phase = 'fallback_sending'
  route.fallbackAt = context.now()
  context.changed(true)
  context.cancelWake(route)
  let sent = false
  try {
    // Why guarded: the write itself refuses if the pane runs another conversation by then.
    sent = await inner.enqueue(pane, route.target, route.id, route.text, route.delivery, {
      guardConversation: true
    })
  } catch (error) {
    console.warn('[answer-inbox] typed fallback failed', error)
  }
  route.phase = sent ? 'fallback' : 'fallback_failed'
  if (sent) {
    context.record(route, 'typed_fallback', item)
    inner.audit(route.delivery, `no hook took it in time; typed into pane ${pane.paneKey}`)
  }
  context.changed(true)
}

/** A typed send a restart cut off: the real queue says whether it was enqueued. */
export function reconcileTypedSend(route: HookFirstRoute, queued: QueueEntryState): void {
  route.phase = queued === 'missing' || queued === 'failed-unsent' ? 'fallback_failed' : 'fallback'
}

/** The one short line that wakes an idle agent; guarded like the answer itself. */
export function enqueueWakeLine(
  inner: WorkDeliveryDeps,
  pane: WorkPane,
  target: WorkDeliveryTarget,
  id: string
): Promise<boolean> {
  return inner.enqueue(pane, target, wakeQueueId(id), HOOK_FIRST_WAKE_LINE, undefined, {
    guardConversation: true
  })
}
