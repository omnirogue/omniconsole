/** Types and limits shared by the work-delivery claimer and its follow-up. */

import { createHash } from 'node:crypto'
import type { PromptQueueEntry } from '../../shared/prompt-queue-types'
import type { WorkDeliveryApi } from './work-delivery-api'
import type {
  ClaimableDelivery,
  WorkDeliveryHeldReason,
  WorkDeliveryKind,
  WorkDeliveryKindAdapter,
  WorkDeliveryTarget
} from './work-delivery-kind'

export type WorkPane = {
  paneKey: string
  worktreeId: string
  tabId: string | null
  archived: boolean
  title: string
}

/** A turn the delivery started that a login failure cut off: `cut_off` until the resume continues or holds it. */
export type WorkLoginCut = {
  state: 'cut_off' | 'resumed' | 'held'
  /** Where the turn runs now: a resume may reopen the conversation in another pane. */
  paneKey: string
  worktreeId?: string
}

export type WorkHolder =
  | { kind: 'live'; pane: WorkPane }
  | { kind: 'blocked'; reason: string }
  | { kind: 'none' }

export type QueueEntryState =
  | 'missing'
  | 'queued'
  | 'sending'
  | 'delivered'
  | 'failed'
  | 'failed-unsent'

/** A prompt-queue entry's state as the claimer reads it; `failed-unsent` is proven never sent. */
export function queueEntryState(entry: PromptQueueEntry | undefined): QueueEntryState {
  if (!entry) {
    return 'missing'
  }
  if (entry.state === 'failed') {
    return entry.unsent ? 'failed-unsent' : 'failed'
  }
  return entry.state
}

/** A refusal before anything started, with the held reason OmniOS records. */
export class WorkDeliveryHold extends Error {
  constructor(
    readonly reason: WorkDeliveryHeldReason,
    message: string
  ) {
    super(message)
  }
}

export type WorkDeliveryDeps = {
  api: WorkDeliveryApi
  adapters: ReadonlyMap<WorkDeliveryKind, WorkDeliveryKindAdapter>
  hostId(): string | null
  hostLabel: string
  resolveTarget(
    adapter: WorkDeliveryKindAdapter,
    delivery: ClaimableDelivery
  ): Promise<WorkDeliveryTarget | null>
  findHolder(target: WorkDeliveryTarget): Promise<WorkHolder>
  windowAttached(): boolean
  unarchive(pane: WorkPane, reason: string): Promise<void>
  /** Resumes the same conversation; throws WorkDeliveryHold when refused before anything started. */
  resume(target: WorkDeliveryTarget, reason: string): Promise<WorkPane>
  /** One fresh session with the brief as its first prompt (sent by the launch itself).
   *  `operationId` is already recorded in OmniOS as this delivery's one fresh start. */
  respawn(
    delivery: ClaimableDelivery,
    target: WorkDeliveryTarget,
    brief: string,
    operationId: string
  ): Promise<WorkPane & { ref: string; conversationId: string | null }>
  enqueue(pane: WorkPane, target: WorkDeliveryTarget, id: string, text: string): Promise<boolean>
  queueState(pane: WorkPane, id: string): QueueEntryState
  /** The agent has a turn in flight (true), is free (false), or cannot be read (null). */
  busy(pane: WorkPane): Promise<boolean | null>
  /** Identity of the pane's last finished turn (null: none, or unreadable); a new one ends a turn too fast to see working. */
  finishedTurn?(pane: WorkPane): Promise<string | null>
  /** True once the agent in a pane just reopened can be proven, waiting at most `waitMs`. */
  waitForAgent?(pane: WorkPane, waitMs: number): Promise<boolean>
  /** The target's account can run a turn; an expired login would end the turn at once. */
  loginReady?(target: WorkDeliveryTarget): Promise<{ ready: boolean; reason?: string }>
  /** The newest login failure that cut off a turn in the pane at or after `since`. */
  loginCut?(pane: WorkPane, since: number): WorkLoginCut | null
  /** Runs the adapter's `restoreDeleted` (an audited organization change). */
  restoreDeleted?(
    adapter: WorkDeliveryKindAdapter,
    delivery: ClaimableDelivery,
    target: WorkDeliveryTarget
  ): Promise<void>
  /** Types into a prompt the agent has open (an unanswered question); `not_open` falls back to the queue. */
  deliverLive?(
    adapter: WorkDeliveryKindAdapter,
    delivery: ClaimableDelivery,
    target: WorkDeliveryTarget,
    pane: WorkPane
  ): Promise<'typed' | 'not_open'>
  audit(delivery: ClaimableDelivery, summary: string): void
  now(): number
}

/** How long a sent entry may go without the agent showing a turn before it is held unverifiable. */
export const WORK_DELIVERY_WORKING_GRACE_MS = 10 * 60_000
/** How long a working session is followed for its `done`; after that it is simply let go. */
export const WORK_DELIVERY_DONE_FOLLOW_MS = 4 * 60 * 60_000
/** Two free readings at least this far apart mean the turn finished. */
export const WORK_DELIVERY_DONE_IDLE_GAP_MS = 5_000
/** How long a reopened pane's agent may take to start before nothing is sent and it is offered again. */
export const WORK_DELIVERY_AGENT_START_WAIT_MS = 30_000
export const MAX_CLAIMS_PER_PASS = 10

export type Watch = {
  delivery: ClaimableDelivery
  target: WorkDeliveryTarget
  pane: WorkPane
  queueId: string | null
  phase: 'queued' | 'typed' | 'working'
  since: number
  /** When it was handed to the pane: a login failure after this cut off its turn. */
  handedAt: number
  loginCut: WorkLoginCut['state'] | null
  renewedAt: number
  /** This delivery reopened something; the next start waits until it is working. */
  started: boolean
  freeSince: number | null
  /** The last finished turn before it was handed over; undefined when not known (a re-claim). */
  turnBefore?: string | null
  /** A newer finished turn seen while `typed`, waiting one idle gap before it counts. */
  turnSeen?: string
}

/** The prompt-queue id is derived from the delivery key, so a retry never queues a second copy. */
export function workDeliveryQueueId(key: string): string {
  return `wd-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
}

export const RENEW_MS = 120_000

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** False only for a kind that claims just the conversations this computer holds, when this one does not. */
export async function heldHere(
  deps: Pick<WorkDeliveryDeps, 'adapters' | 'resolveTarget'>,
  offered: ClaimableDelivery
): Promise<boolean> {
  const adapter = deps.adapters.get(offered.kind)
  if (!adapter?.claimOnlyWhenHeld) {
    return true
  }
  try {
    return (await deps.resolveTarget(adapter, offered)) !== null
  } catch {
    return false
  }
}
