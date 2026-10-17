/**
 * The next prompt a person would otherwise have typed, held until the agent finishes.
 *
 * This is a Conversation primitive: Message → Response, one FIFO per conversation.
 * It creates no Outcome, no chain, no WorkPlan and no card. The queued text is
 * delivered through the same door the person's own composer uses, unchanged — no
 * brief, no wrapper, no prefix this file adds.
 *
 * A delivery leaves a receipt on the entry BEFORE the write is attempted, so a
 * restart can always tell "already sent" from "never sent" and never re-sends.
 */

import type { ConversationSource } from './conversation-source'
import { normalizeConversationSource } from './conversation-source'
import {
  CAPACITY_RECOVERY_ENTRY_PREFIX,
  normalizeConversationCapacityRecovery,
  type ConversationCapacityRecovery
} from './conversation-capacity-recovery'
import { isSessionHostConversationId, isSessionHostOperationId } from './session-host-identity'
import {
  normalizeSessionContextQueueOrigin,
  type SessionContextQueueOrigin
} from './session-context-queue'

export type { ConversationCapacityRecovery } from './conversation-capacity-recovery'

export type PromptQueueEntryState = 'queued' | 'sending' | 'delivered' | 'failed'

/** Automatic continuation or saved context carrying its original receiver identity. */
export type PromptQueueEntryOrigin =
  | { kind: 'keep-going'; runToken: string; round: number }
  | SessionContextQueueOrigin

/**
 * The person's own request, relayed by another conversation (`omni session continue|ask`).
 * Its own optional field, never an `origin`: a client that predates it keeps the entry (and its
 * visible "[from …]" marker) instead of rejecting an origin it cannot read.
 */
export type PromptQueueRequestedBy = {
  action: 'continue' | 'ask'
  /** The acting pane's key, or `cli` for the plain local CLI. */
  actor: string
  /** The session host operation this entry carries out; a restart reconciles it from the entry. */
  hostOperation?: { operationId: string; conversationId: string }
}

/** What a caller asks the queue to hold; the queue stamps the rest. */
export type PromptQueueEnqueueInput = {
  id: string
  text: string
  origin?: PromptQueueEntryOrigin
  requestedBy?: PromptQueueRequestedBy
}

export type PromptQueueEntry = {
  id: string
  text: string
  createdAt: number
  state: PromptQueueEntryState
  /** Minted when the entry is admitted for delivery; the door's idempotency key. */
  operationId?: string
  /** Which process attempted the delivery; a foreign epoch is an unconfirmed send. */
  deliveryEpoch?: string
  deliveredAt?: number
  door?: ConversationSourceKindDoor
  /** Why it could not be delivered. Set with `failed`, never cleared silently. */
  reason?: string
  /** `failed` with proof that no byte of it reached the conversation. */
  unsent?: true
  /** A failed prompt of the person's: the queue waits behind it until they dismiss or re-queue it. */
  holdsQueue?: true
  /** A queued answer refused before any byte moved, waiting to go again (`prompt-queue-answer-retry.ts`). */
  retry?: PromptQueueRetry
  origin?: PromptQueueEntryOrigin
  requestedBy?: PromptQueueRequestedBy
}

type ConversationSourceKindDoor = 'pty' | 'structured'

export type PromptQueueRetry = {
  /** Attempts refused so far. */
  attempts: number
  /** When the first refused attempt ended; the retry window runs from here. */
  firstAt: number
  /** The drain leaves it until then. */
  notBefore: number
  /** The last refusal, in the door's words. */
  reason?: string
}

export type PromptQueue = {
  /** The conversation this queue belongs to; the address its entries are sent to. */
  source: ConversationSource
  entries: PromptQueueEntry[]
  recovery?: ConversationCapacityRecovery
}

/**
 * Why the queue is not moving, on `promptQueue.list`. Optional and additive: an old client
 * never reads it, and a new client ignores a `kind` it does not know.
 */
export type PromptQueueWaitReason = { kind: 'paused-after-failure'; entryId: string }

export type PromptQueues = Record<string, PromptQueue>

export const PROMPT_QUEUE_MAX_ENTRIES = 25
export const PROMPT_QUEUE_FULL_REFUSAL =
  'This conversation already has the most prompts it can hold.'
export const PROMPT_QUEUE_ONE_IN_FLIGHT =
  'Another prompt is being sent to this conversation right now, so this one waits in its queue.'
export const PROMPT_QUEUE_MAX_TEXT_LENGTH = 32_000
/** Delivered/failed entries kept per queue so the strip can show what happened. */
export const PROMPT_QUEUE_MAX_SETTLED_ENTRIES = 25
export const PROMPT_QUEUE_MAX_REASON_LENGTH = 500

export const PROMPT_QUEUE_RPC = {
  list: 'promptQueue.list',
  enqueue: 'promptQueue.enqueue',
  remove: 'promptQueue.remove',
  reorder: 'promptQueue.reorder',
  requeue: 'promptQueue.requeue',
  clearDelivered: 'promptQueue.clearDelivered'
} as const

const STATES: readonly PromptQueueEntryState[] = ['queued', 'sending', 'delivered', 'failed']
const DOORS: readonly ConversationSourceKindDoor[] = ['pty', 'structured']

function finiteTime(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null
}

/**
 * One entry, rebuilt field by field. Null when the record cannot be read — the
 * CALLER drops that entry and keeps the rest of the queue: a queue is a list of
 * independent messages, and one unreadable row is not a reason to lose the others.
 */
export function normalizePromptQueueEntry(raw: unknown): PromptQueueEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }
  const value = raw as Record<string, unknown>
  const id = boundedString(value.id, 200)?.trim()
  const text =
    typeof value.text === 'string' ? value.text.slice(0, PROMPT_QUEUE_MAX_TEXT_LENGTH) : ''
  const createdAt = finiteTime(value.createdAt)
  const state = STATES.find((candidate) => candidate === value.state)
  if (!id || !text.trim() || createdAt === null || !state) {
    return null
  }
  const operationId = boundedString(value.operationId, 200)
  const deliveryEpoch = boundedString(value.deliveryEpoch, 200)
  const deliveredAt = finiteTime(value.deliveredAt)
  const door = DOORS.find((candidate) => candidate === value.door)
  const reason = boundedString(value.reason, PROMPT_QUEUE_MAX_REASON_LENGTH)
  const retry = readRetry(value.retry)
  // Pre-release builds of `omni session` wrote the relay as an origin; read it as what it is.
  const legacyRelay = readRequestedBy(value.origin, (raw) => raw.kind === 'session')
  const requestedBy = readRequestedBy(value.requestedBy) ?? legacyRelay
  const origin = legacyRelay ? null : normalizePromptQueueEntryOrigin(value.origin)
  // An unreadable origin must not turn an automatic entry into one that reads as the person's.
  if (value.origin !== undefined && !origin && !legacyRelay) {
    return null
  }
  return {
    id,
    text,
    createdAt,
    state,
    ...(operationId ? { operationId } : {}),
    ...(deliveryEpoch ? { deliveryEpoch } : {}),
    ...(deliveredAt !== null ? { deliveredAt } : {}),
    ...(door ? { door } : {}),
    ...(reason ? { reason } : {}),
    ...(state === 'failed' && value.unsent === true ? { unsent: true as const } : {}),
    ...(state === 'failed' && value.holdsQueue === true ? { holdsQueue: true as const } : {}),
    ...(retry ? { retry } : {}),
    ...(origin ? { origin } : {}),
    ...(requestedBy ? { requestedBy } : {})
  }
}

function readRetry(raw: unknown): PromptQueueRetry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }
  const value = raw as Record<string, unknown>
  const attempts = value.attempts
  const firstAt = finiteTime(value.firstAt)
  const notBefore = finiteTime(value.notBefore)
  if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 1) {
    return null
  }
  if (firstAt === null || notBefore === null) {
    return null
  }
  const reason = boundedString(value.reason, PROMPT_QUEUE_MAX_REASON_LENGTH)
  return { attempts, firstAt, notBefore, ...(reason ? { reason } : {}) }
}

function readRequestedBy(
  raw: unknown,
  accept: (value: Record<string, unknown>) => boolean = () => true
): PromptQueueRequestedBy | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }
  const value = raw as Record<string, unknown>
  const actor = boundedString(value.actor, 1000)
  if (!accept(value) || !actor || (value.action !== 'continue' && value.action !== 'ask')) {
    return null
  }
  const operation = value.hostOperation as Record<string, unknown> | undefined
  const hostOperation =
    operation &&
    isSessionHostOperationId(operation.operationId) &&
    isSessionHostConversationId(operation.conversationId)
      ? { operationId: operation.operationId, conversationId: operation.conversationId }
      : null
  return { action: value.action, actor, ...(hostOperation ? { hostOperation } : {}) }
}

function normalizePromptQueueEntryOrigin(raw: unknown): PromptQueueEntryOrigin | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }
  const value = raw as Record<string, unknown>
  if (value.kind === 'session-context') {
    return normalizeSessionContextQueueOrigin(raw)
  }
  const runToken = boundedString(value.runToken, 64)
  const round = value.round
  return value.kind === 'keep-going' &&
    runToken &&
    typeof round === 'number' &&
    Number.isInteger(round) &&
    round >= 1
    ? { kind: 'keep-going', runToken, round }
    : null
}

/** One queue. Null only when the conversation it names cannot be addressed. */
export function normalizePromptQueue(raw: unknown): PromptQueue | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }
  const value = raw as Record<string, unknown>
  const source = normalizeConversationSource(value.source)
  if (!source) {
    return null
  }
  const entries = Array.isArray(value.entries)
    ? value.entries
        .map(normalizePromptQueueEntry)
        .filter((entry): entry is PromptQueueEntry => entry !== null)
    : []
  const recovery = normalizeConversationCapacityRecovery(value.recovery)
  return {
    source,
    entries: capPromptQueueEntries(entries),
    ...(recovery ? { recovery } : {})
  }
}

export function normalizePromptQueues(raw: unknown): PromptQueues {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {}
  }
  const queues: PromptQueues = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const queue = normalizePromptQueue(value)
    if (queue && (queue.entries.length || queue.recovery)) {
      queues[key] = queue
    }
  }
  return queues
}

export function isPromptQueueEntrySettled(entry: PromptQueueEntry): boolean {
  return entry.state === 'delivered' || entry.state === 'failed'
}

/** Waiting and in-flight entries, in the order they were queued. */
export function promptQueuePending(queue: PromptQueue): PromptQueueEntry[] {
  return queue.entries.filter((entry) => !isPromptQueueEntrySettled(entry))
}

/**
 * Work nobody is watching: a Keep going round, another session's relayed request (the steward's
 * included) or a capacity-recovery brief. It never pauses the queue and is never paused by it,
 * so unattended work keeps draining.
 */
export function isUnattendedPromptQueueEntry(entry: PromptQueueEntry): boolean {
  return Boolean(
    entry.origin || entry.requestedBy || entry.id.startsWith(CAPACITY_RECOVERY_ENTRY_PREFIX)
  )
}

/** The person's failed prompt the queue is paused behind, or null when it is not paused. */
export function promptQueuePausedBy(queue: PromptQueue): PromptQueueEntry | null {
  return queue.entries.find((entry) => entry.state === 'failed' && entry.holdsQueue) ?? null
}

export function promptQueueWaitReason(queue: PromptQueue): PromptQueueWaitReason | null {
  const paused = promptQueuePausedBy(queue)
  return paused ? { kind: 'paused-after-failure', entryId: paused.id } : null
}

/**
 * The entry the drain may send next: the FIRST unsettled one, and only when it is
 * still `queued`. An entry already marked `sending` holds the line — nothing may
 * overtake a delivery whose result is not yet known, wherever in the queue it sits
 * ("send now" admits an entry that is not the head). While the queue is paused behind
 * a failed prompt, only unattended work goes. Given `now`, an answer waiting out its retry
 * backoff steps aside until then.
 */
export function nextPromptQueueEntry(queue: PromptQueue, now?: number): PromptQueueEntry | null {
  const all = promptQueuePending(queue)
  if (all.some((entry) => entry.state === 'sending')) {
    return null
  }
  const pending =
    now === undefined ? all : all.filter((entry) => (entry.retry?.notBefore ?? 0) <= now)
  if (promptQueuePausedBy(queue)) {
    return pending.find(isUnattendedPromptQueueEntry) ?? null
  }
  return pending[0] ?? null
}

/** Keeps every unsettled entry and the most recent settled ones. */
export function capPromptQueueEntries(entries: readonly PromptQueueEntry[]): PromptQueueEntry[] {
  // A failed prompt the queue is paused behind is kept until the person acts on it.
  const settled = entries.filter((entry) => isPromptQueueEntrySettled(entry) && !entry.holdsQueue)
  const dropped = new Set(
    settled.slice(0, Math.max(0, settled.length - PROMPT_QUEUE_MAX_SETTLED_ENTRIES))
  )
  return entries.filter((entry) => !dropped.has(entry))
}

export function promptQueueTextRefusal(text: string): string | null {
  if (!text.trim()) {
    return 'Type the prompt to queue.'
  }
  if (text.length > PROMPT_QUEUE_MAX_TEXT_LENGTH) {
    return 'That prompt is too long to queue.'
  }
  return null
}

export function emptyPromptQueue(source: ConversationSource): PromptQueue {
  return { source, entries: [] }
}
