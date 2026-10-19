/** One hook-first delivery's record, and what it reports: the pilot line and the receipt's path. */

import type { AnswerDeliveryPilotRecord } from '../../shared/answer-delivery-pilot-report'
import { parseSessionReference } from '../../shared/session-reference'
import type { WorkDeliveryReceipt } from '../work-delivery/work-delivery-api'
import type { WorkPane } from '../work-delivery/work-delivery-claimer-types'
import type { ClaimableDelivery, WorkDeliveryTarget } from '../work-delivery/work-delivery-kind'
import {
  ANSWER_MAX_HOOK_COPIES,
  ANSWER_PATH_BY_EVENT,
  answerConversationText,
  type AnswerConversation,
  type AnswerItem
} from './answer-inbox'

export const HOOK_FIRST_WORKING_WAIT_MS = 5 * 60_000
export const HOOK_FIRST_WAKE_WAIT_MS = 2 * 60_000
/** Settled routes are kept this long so a re-claim after a restart still reads `delivered`. */
export const HOOK_FIRST_SETTLED_KEEP_MS = 4 * 60 * 60_000
export const HOOK_FIRST_WAKE_LINE = '[OmniOS] An answer is waiting; it is in your context.'
/** What a `busy` hold says while the answer still waits in the inbox for a hook. */
export const HOOK_FIRST_WAITING_MESSAGE =
  "Waiting for the agent's next step to carry the answer in (hook-first); it is typed if no hook takes it."

export type HookFirstRoute = {
  id: string
  delivery: ClaimableDelivery
  target: WorkDeliveryTarget
  conversation: AnswerConversation
  text: string
  claimedAt: number
  pane: WorkPane | null
  /** Handed to the pane (null: offered before a resume, not handed over yet). */
  handedAt: number | null
  mode: 'working' | 'woken' | null
  /** `fallback_sending` is saved before the typed enqueue, so a restart reconciles with the queue. */
  phase: 'hook' | 'fallback_sending' | 'fallback' | 'fallback_failed'
  fallbackAt: number | null
  /** A queued wake line was taken back once the answer was carried or typed. */
  wakeCancelled: boolean
  /** The typed receipt carried its path and latency. */
  reported: boolean
  logged: boolean
}

export type HookFirstSnapshot = { routes: HookFirstRoute[]; items: AnswerItem[] }

export function wakeQueueId(id: string): string {
  return `${id}-wake`
}

/** Only a Claude/Codex conversation this computer holds itself. */
export function localConversation(target: WorkDeliveryTarget): AnswerConversation | null {
  const reference = parseSessionReference(target.ref)
  return reference && reference.hostId === 'local'
    ? { provider: reference.agent, sessionId: reference.sessionId }
    : null
}

const iso = (at: number | null | undefined) => (at ? new Date(at).toISOString() : null)

export function pilotRecord(
  route: HookFirstRoute,
  outcome: AnswerDeliveryPilotRecord['outcome'],
  item: AnswerItem | undefined
): AnswerDeliveryPilotRecord {
  return {
    key: route.delivery.key,
    id: route.id,
    conversation: answerConversationText(route.conversation),
    path:
      outcome === 'typed_fallback'
        ? 'typed_fallback'
        : item?.injectedBy
          ? ANSWER_PATH_BY_EVENT[item.injectedBy]
          : null,
    claimedAt: iso(route.claimedAt)!,
    injectedAt: iso(item?.injectedAt),
    confirmedAt: iso(item?.confirmedAt),
    fallbackAt: iso(route.fallbackAt),
    ackAt: null,
    attempts: item?.attempts ?? 0,
    outcome
  }
}

/** The first `typed` receipt once it was confirmed or typed, with its path and latency; else null. */
export function receiptWithPath(
  route: HookFirstRoute,
  item: AnswerItem | undefined,
  receipt: WorkDeliveryReceipt,
  now: number
): WorkDeliveryReceipt | null {
  if (route.reported || receipt.state !== 'typed') {
    return null
  }
  const settled =
    route.phase === 'fallback'
      ? { path: 'typed_fallback' as const, at: now }
      : route.phase === 'hook' && item?.state === 'confirmed' && item.injectedBy
        ? { path: ANSWER_PATH_BY_EVENT[item.injectedBy], at: item.confirmedAt ?? now }
        : null
  if (!settled) {
    return null
  }
  const latencyMs = Math.max(0, settled.at - route.claimedAt)
  return {
    ...receipt,
    path: settled.path,
    latencyMs,
    detail: { ...receipt.detail, path: settled.path, latencyMs }
  }
}

export function newRoute(
  fields: Pick<HookFirstRoute, 'id' | 'delivery' | 'target' | 'conversation' | 'text' | 'pane'>,
  claimedAt: number
): HookFirstRoute {
  return {
    ...fields,
    claimedAt,
    handedAt: null,
    mode: null,
    phase: 'hook',
    fallbackAt: null,
    wakeCancelled: false,
    reported: false,
    logged: false
  }
}

/**
 * After a restart waiting items get a fresh window, and an item comes back only beside a route
 * still waiting for a hook, never beside a typed (or mid-typing) one, which the queue reconciles.
 */
export function restoredSnapshot(snapshot: HookFirstSnapshot, now: number): HookFirstSnapshot {
  const routes = snapshot.routes.map((route) => ({
    ...route,
    handedAt: route.handedAt === null ? null : now
  }))
  const waiting = new Set(routes.filter((route) => route.phase === 'hook').map((r) => r.id))
  return { routes, items: snapshot.items.filter((item) => waiting.has(item.id)) }
}

/** The audit line of that hold, worded the same way. */
export function auditWhileWaiting(summary: string): string {
  return summary.startsWith('held (busy):') ? `held (busy): ${HOOK_FIRST_WAITING_MESSAGE}` : summary
}

/** A `busy` hold of an answer still in the inbox says it waits for a hook, not behind a turn. */
export function heldWhileWaiting(receipt: WorkDeliveryReceipt): WorkDeliveryReceipt {
  return receipt.state === 'held' && receipt.heldReason === 'busy'
    ? { ...receipt, detail: { ...receipt.detail, message: HOOK_FIRST_WAITING_MESSAGE } }
    : receipt
}

/** What a pass does with a route: keep waiting, forget it (settled long ago), drop or type it. */
export function hookFirstTickStep(
  route: HookFirstRoute,
  item: AnswerItem | undefined,
  now: number,
  enabled: boolean
): 'keep' | 'forget' | 'drop' | 'type' {
  if (route.phase !== 'hook' || item?.state === 'confirmed') {
    const settledAt = route.phase === 'hook' ? (item?.confirmedAt ?? now) : route.fallbackAt
    return settledAt !== null && now - settledAt > HOOK_FIRST_SETTLED_KEEP_MS ? 'forget' : 'keep'
  }
  if (!enabled) {
    // Why: a hook may already have carried it (or may still ack it); only a never-carried one is typed.
    if (!item || item.state !== 'offered' || item.attempts > 0) {
      return 'keep'
    }
    return route.handedAt === null ? 'drop' : 'type'
  }
  if (route.handedAt === null) {
    // Offered for a resume that never handed it over.
    return now - route.claimedAt > 2 * HOOK_FIRST_WORKING_WAIT_MS ? 'drop' : 'keep'
  }
  if (item?.state !== 'offered') {
    return 'keep'
  }
  if (item.sends.length >= ANSWER_MAX_HOOK_COPIES) {
    // Why: its hook copy is spent (never acknowledged, or never confirmed); the typed copy is the
    // only repeat, and it goes now.
    return 'type'
  }
  const wait = route.mode === 'woken' ? HOOK_FIRST_WAKE_WAIT_MS : HOOK_FIRST_WORKING_WAIT_MS
  return now >= Math.max(route.handedAt + wait, (item.reofferedAt ?? 0) + wait) ? 'type' : 'keep'
}
