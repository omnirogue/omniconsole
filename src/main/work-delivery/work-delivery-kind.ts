/**
 * The shared contract for answers and replies that must reach the session that owns the work
 * (Ops/Projects/Decision-Delivery-Reliability-2026-10-11/work-delivery-contract.md). OmniOS keeps
 * one delivery record per event; this desktop claims it with a lease, reopens the owner's
 * conversation and reports receipts. Each kind (jira, review, question, message) supplies an adapter.
 */

import type { OrcaRuntimeService } from '../runtime/omni-runtime'

export type WorkDeliveryKind = 'jira' | 'review' | 'question' | 'message'

export type WorkDeliveryOwner = {
  hostId: string
  hostLabel: string
  provider: string
  accountId: string
  conversationId: string
  model: string
  effort: string
  folder: string
  paneKey: string
  title: string
}

export type ClaimableDelivery = {
  key: string
  workItem: string
  kind: WorkDeliveryKind
  text: string
  context: Record<string, unknown>
  state: 'pending' | 'claimed' | 'typed' | 'working' | 'done' | 'held' | 'superseded'
  step: string
  heldReason: string | null
  attempts: number
  createdAt: string | null
  eventAt: string | null
  respawnedRef: string | null
  owner: WorkDeliveryOwner | null
}

export type WorkDeliveryTarget = {
  ref: string
  paneKey?: string
  accountId?: string
  model?: string
  effort?: string
  folder?: string
  archived?: boolean
  deleted?: boolean
  transcript: 'present' | 'gone'
}

/**
 * Proof, found before anything is sent, that this decision already reached its session: a receipt
 * written when it was delivered (the review pass's settled queue entry, the choices notifier's
 * read or delivered key for this decision id). Never inferred from a page or slug being mentioned.
 */
export type WorkDeliveryAlreadyDelivered = {
  delivered: 'receipt'
  /** What proved it, for the audit log. */
  evidence: string
  /** The session it reached, when known. */
  ref: string | null
}

export type WorkDeliveryResolution = WorkDeliveryTarget | WorkDeliveryAlreadyDelivered | null

export function isAlreadyDelivered(
  resolution: WorkDeliveryResolution
): resolution is WorkDeliveryAlreadyDelivered {
  return resolution !== null && 'delivered' in resolution
}

export type WorkDeliveryKindAdapter = {
  kind: WorkDeliveryKind
  /**
   * Resolve before claiming, and leave it unclaimed when `resolve` finds nothing: OmniOS offers
   * these to every computer of the person, and only the one holding the conversation takes it.
   */
  claimOnlyWhenHeld?: boolean
  /** Never start a fresh session: a gone transcript is held `transcript_gone`. */
  noRespawn?: boolean
  /**
   * Before a handover is held as unconfirmable, the target's transcript is read for the delivered
   * text itself (a user turn after the event); a mention of the page is never proof.
   */
  confirmByTranscript?: true
  resolve(delivery: ClaimableDelivery, runtime: OrcaRuntimeService): Promise<WorkDeliveryResolution>
  text(delivery: ClaimableDelivery, target: WorkDeliveryTarget): string
  /** Brings back a conversation the person deleted, as an audited organization change (approved by answering). */
  restoreDeleted?(
    delivery: ClaimableDelivery,
    target: WorkDeliveryTarget,
    runtime: OrcaRuntimeService
  ): Promise<void>
  /** The brief for a fresh session when the conversation's transcript is gone. */
  respawnBrief?(delivery: ClaimableDelivery, target: WorkDeliveryTarget): string
  /** Optional: deliver into the live pane without the prompt queue (Question answers typed into the open prompt). */
  deliverLive?(
    delivery: ClaimableDelivery,
    target: WorkDeliveryTarget,
    runtime: OrcaRuntimeService
  ): Promise<'typed' | 'not_open'>
}

/** An adapter whose `resolve` only ever finds a session, never a receipt. */
export type WorkDeliveryTargetAdapter = Omit<WorkDeliveryKindAdapter, 'resolve'> & {
  resolve(
    delivery: ClaimableDelivery,
    runtime: OrcaRuntimeService
  ): Promise<WorkDeliveryTarget | null>
}

export const WORK_DELIVERY_HELD_REASONS = [
  'login_failed',
  'host_offline',
  'account_at_limit',
  'transcript_gone',
  'protection',
  'no_window',
  'not_found',
  'busy',
  'unverifiable',
  'error'
] as const
export type WorkDeliveryHeldReason = (typeof WORK_DELIVERY_HELD_REASONS)[number]

export type WorkDeliveryStep =
  | 'claimed'
  | 'queued'
  | 'unarchived'
  | 'resumed'
  | 'restored'
  | 'respawned'
  | 'peer_sent'
  | 'released'
  /** A recorded fresh start refused before anything started; the next attempt replaces it. */
  | 'not_started'

/** A fresh start was recorded and may have started, so a second one is never launched. */
export function respawnMayHaveStarted(delivery: ClaimableDelivery): boolean {
  return !!delivery.respawnedRef && delivery.step !== 'not_started'
}
