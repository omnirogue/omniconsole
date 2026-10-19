/**
 * `omni session continue --prompt … --when-idle` (and `session assign … --when-idle`): a prompt
 * held for a busy session and sent the moment it is free, through the same guarded
 * `continue --prompt` path, exactly once. If its
 * window ends first it is not sent and nothing is launched elsewhere: it is reported back.
 */

import type { SessionManageActionResult, SessionManageActor } from './session-manage-types'

export type SessionPendingDeliveryState =
  /** Held until the target is free. */
  | 'waiting'
  /** Being sent now; after a restart this reads `unknown`, never sent twice. */
  | 'delivering'
  | 'delivered'
  /** The target can no longer take it (gone, exited, another host). */
  | 'refused'
  /** Its window ended before the target was free; not sent. */
  | 'expired'
  | 'cancelled'
  /** OmniConsole stopped while it was being sent: check the target before sending again. */
  | 'unknown'

export type SessionPendingDelivery = {
  id: string
  createdAt: number
  expiresAt: number
  actor: SessionManageActor
  target: { paneKey: string; tabId: string | null; title: string }
  /** `assign` sends it as a new task (`session assign`); absent is `continue --prompt`. */
  kind?: 'continue' | 'assign'
  text: string
  reason?: string
  request?: string
  state: SessionPendingDeliveryState
  /** Why it still waits, or how it ended, in plain words. */
  note?: string
  settledAt?: number
  /** The prompt-queue entry it became. */
  entryId?: string
  /** When its requester first listed it after it ended unsent (`omni session pending`). */
  seenAt?: number
}

export type SessionContinueWhenIdleResult = SessionManageActionResult & {
  /** Absent on a dry run, and when it was sent at once because the target was already free. */
  pending?: SessionPendingDelivery
  delivered?: boolean
}

export type SessionPendingListResult = { deliveries: SessionPendingDelivery[] }

export const SESSION_WHEN_IDLE_DEFAULT_MS = 30 * 60_000
export const SESSION_WHEN_IDLE_MIN_MS = 60_000
export const SESSION_WHEN_IDLE_MAX_MS = 4 * 60 * 60_000

export function isSessionPendingDeliverySettled(delivery: SessionPendingDelivery): boolean {
  return delivery.state !== 'waiting' && delivery.state !== 'delivering'
}

/** It ended without reaching its session (window over, or cut off mid-send) and its requester has not listed it since. */
export function isUnseenUnsentDelivery(delivery: SessionPendingDelivery): boolean {
  return (delivery.state === 'expired' || delivery.state === 'unknown') && !delivery.seenAt
}

/** `30m`, `2h`, `90s` or plain minutes, bounded to the window a held prompt may wait. */
export function parseSessionWhenIdleWindow(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i.exec(value.trim())
  if (!match) {
    return null
  }
  const unit = (match[2] ?? 'm').toLowerCase()
  const ms = Number(match[1]) * (unit === 'h' ? 3_600_000 : unit === 's' ? 1_000 : 60_000)
  return Number.isFinite(ms) && ms >= SESSION_WHEN_IDLE_MIN_MS && ms <= SESSION_WHEN_IDLE_MAX_MS
    ? Math.round(ms)
    : null
}
