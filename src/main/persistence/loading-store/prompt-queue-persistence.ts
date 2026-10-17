import {
  capPromptQueueEntries,
  emptyPromptQueue,
  isPromptQueueEntrySettled,
  isUnattendedPromptQueueEntry,
  normalizePromptQueueEntry,
  PROMPT_QUEUE_FULL_REFUSAL,
  PROMPT_QUEUE_MAX_ENTRIES,
  PROMPT_QUEUE_ONE_IN_FLIGHT,
  promptQueuePending,
  type PromptQueue,
  type PromptQueueEntry,
  type PromptQueueRetry,
  type PromptQueues
} from '../../../shared/prompt-queue-types'
import {
  conversationSourceRowKey,
  type ConversationSource
} from '../../../shared/conversation-source'
import { bumpConversationMutation } from '../../runtime/conversation-mutation-generation'
import type { StoreRuntimeState } from './store-runtime-state'
import {
  normalizeConversationCapacityRecovery,
  type ConversationCapacityRecovery
} from '../../../shared/conversation-capacity-recovery'
import type { WriteSchedulingOperations } from './write-scheduling'
import { scheduleSave } from './write-scheduling'

type PromptQueueRuntime = Pick<StoreRuntimeState, 'state'> &
  Partial<Pick<StoreRuntimeState, 'flushOrThrow' | 'writesFrozen'>>

const promptQueuePersistenceContext = Symbol('PromptQueuePersistence')
type PromptQueuePersistenceContext = {
  runtime: PromptQueueRuntime
  scheduling: WriteSchedulingOperations
}

/**
 * Prompts a person queued for a conversation, kept in the profile state file beside
 * session chains. Nothing here knows about outcomes, plans or cards: the record is a
 * list of the person's own messages and the receipt each one was delivered under.
 *
 * Delivery and capacity handoff receipts must be on disk before their side effects.
 */
export class PromptQueuePersistence {
  readonly [promptQueuePersistenceContext]: PromptQueuePersistenceContext

  constructor(runtime: PromptQueueRuntime, scheduling: WriteSchedulingOperations) {
    this[promptQueuePersistenceContext] = { runtime, scheduling }
  }

  listPromptQueues(): PromptQueues {
    return structuredClone(this[promptQueuePersistenceContext].runtime.state.promptQueues ?? {})
  }

  readPromptQueue(rowKey: string): PromptQueue | null {
    const queue = this[promptQueuePersistenceContext].runtime.state.promptQueues?.[rowKey]
    return queue ? structuredClone(queue) : null
  }

  saveConversationCapacityRecoveryAndFlush(
    source: ConversationSource,
    recovery: ConversationCapacityRecovery | null
  ): PromptQueue {
    const context = this[promptQueuePersistenceContext]
    if (!context.runtime.flushOrThrow || context.runtime.writesFrozen) {
      throw new Error('Durable capacity-recovery receipts are unavailable on this host.')
    }
    const normalized = recovery === null ? null : normalizeConversationCapacityRecovery(recovery)
    if (recovery !== null && !normalized) {
      throw new Error('That capacity-recovery receipt is invalid.')
    }
    const rowKey = conversationSourceRowKey(source)
    const previous = context.runtime.state.promptQueues ?? {}
    const queue = { ...(previous[rowKey] ?? emptyPromptQueue(source)), source }
    if (normalized) {
      queue.recovery = normalized
    } else {
      delete queue.recovery
    }
    const next = this.replace(previous, rowKey, queue)
    context.runtime.state.promptQueues = next
    try {
      context.runtime.flushOrThrow()
    } catch (error) {
      context.runtime.state.promptQueues = previous
      throw error
    }
    return structuredClone(next[rowKey] ?? queue)
  }

  enqueuePromptQueueEntry(source: ConversationSource, input: unknown): PromptQueue {
    const entry = normalizePromptQueueEntry(input)
    if (!entry || entry.state !== 'queued') {
      throw new Error('A queued prompt needs an id, text and a time it was written.')
    }
    return this.write(conversationSourceRowKey(source), source, (queue) => {
      if (promptQueuePending(queue).length >= PROMPT_QUEUE_MAX_ENTRIES) {
        throw new Error(PROMPT_QUEUE_FULL_REFUSAL)
      }
      if (queue.entries.some((existing) => existing.id === entry.id)) {
        return queue
      }
      return { ...queue, source, entries: [...queue.entries, entry] }
    })
  }

  removePromptQueueEntry(rowKey: string, entryId: string): PromptQueue | null {
    return this.writeExisting(rowKey, (queue) => ({
      ...queue,
      // A delivery already under way is not withdrawable: the bytes may be gone.
      entries: queue.entries.filter((entry) => entry.id !== entryId || entry.state === 'sending')
    }))
  }

  /** Moves one waiting entry one place earlier or later among the waiting entries. */
  reorderPromptQueueEntry(
    rowKey: string,
    entryId: string,
    direction: 'up' | 'down'
  ): PromptQueue | null {
    return this.writeExisting(rowKey, (queue) => {
      const waiting = queue.entries.filter((entry) => entry.state === 'queued')
      const index = waiting.findIndex((entry) => entry.id === entryId)
      const target = index + (direction === 'up' ? -1 : 1)
      if (index === -1 || target < 0 || target >= waiting.length) {
        return queue
      }
      const reordered = [...waiting]
      reordered[index] = waiting[target]!
      reordered[target] = waiting[index]!
      let position = 0
      return {
        ...queue,
        entries: queue.entries.map((entry) =>
          entry.state === 'queued' ? reordered[position++]! : entry
        )
      }
    })
  }

  /**
   * "Queue again": the person's failed prompt becomes a fresh entry at the head of the waiting
   * ones, under a new id so its old delivery receipt is never reused. That clears its pause.
   */
  requeuePromptQueueEntry(
    rowKey: string,
    entryId: string,
    fresh: { id: string; createdAt: number }
  ): PromptQueue | null {
    return this.writeExisting(rowKey, (queue) => {
      const failed = queue.entries.find((entry) => entry.id === entryId)
      if (!failed || failed.state !== 'failed' || isUnattendedPromptQueueEntry(failed)) {
        throw new Error('That prompt is no longer waiting to be queued again.')
      }
      if (promptQueuePending(queue).length >= PROMPT_QUEUE_MAX_ENTRIES) {
        throw new Error(PROMPT_QUEUE_FULL_REFUSAL)
      }
      const requeued: PromptQueueEntry = { ...fresh, text: failed.text, state: 'queued' }
      const rest = queue.entries.filter((entry) => entry.id !== entryId)
      const head = rest.findIndex((entry) => !isPromptQueueEntrySettled(entry))
      const at = head === -1 ? rest.length : head
      return { ...queue, entries: [...rest.slice(0, at), requeued, ...rest.slice(at)] }
    })
  }

  clearDeliveredPromptQueueEntries(rowKey: string): PromptQueue | null {
    return this.writeExisting(rowKey, (queue) => ({
      ...queue,
      entries: queue.entries.filter((entry) => !isPromptQueueEntrySettled(entry))
    }))
  }

  /**
   * Durable admission: the entry becomes `sending` with its operation id and the
   * epoch of the process that took it, and the state file is flushed before the
   * caller writes a byte. Throws if this host cannot flush — a delivery nobody can
   * prove is worse than a delivery that did not happen.
   */
  markPromptQueueEntrySendingAndFlush(
    rowKey: string,
    entryId: string,
    delivery: { operationId: string; deliveryEpoch: string }
  ): PromptQueue {
    const context = this[promptQueuePersistenceContext]
    if (!context.runtime.flushOrThrow || context.runtime.writesFrozen) {
      throw new Error('Durable prompt-queue receipts are unavailable on this host.')
    }
    const previous = context.runtime.state.promptQueues ?? {}
    const queue = previous[rowKey]
    const entry = queue?.entries.find((candidate) => candidate.id === entryId)
    if (!queue || !entry || entry.state !== 'queued') {
      throw new Error('That queued prompt is no longer waiting.')
    }
    // Why here and not at each caller: the drain and "send now" admit from different ticks.
    if (queue.entries.some((candidate) => candidate.state === 'sending')) {
      throw new Error(PROMPT_QUEUE_ONE_IN_FLIGHT)
    }
    const next = this.replace(previous, rowKey, {
      ...queue,
      entries: queue.entries.map((candidate) =>
        candidate.id === entryId
          ? { ...candidate, state: 'sending' as const, ...delivery }
          : candidate
      )
    })
    context.runtime.state.promptQueues = next
    try {
      context.runtime.flushOrThrow()
    } catch (error) {
      context.runtime.state.promptQueues = previous
      throw error
    }
    return structuredClone(next[rowKey]!)
  }

  /**
   * Records how a delivery ended. Never moves an entry back to `queued`. A failed prompt of the
   * person's pauses the queue behind it (`holdsQueue`); unattended work never does.
   */
  settlePromptQueueEntry(
    rowKey: string,
    entryId: string,
    settlement:
      | { state: 'delivered'; deliveredAt: number; door: 'pty' | 'structured' }
      | { state: 'failed'; reason: string; unsent?: true }
  ): PromptQueue | null {
    return this.writeExisting(rowKey, (queue) => ({
      ...queue,
      entries: queue.entries.map((entry) =>
        entry.id === entryId && !isPromptQueueEntrySettled(entry)
          ? ({
              ...entry,
              ...settlement,
              ...(settlement.state === 'failed' && !isUnattendedPromptQueueEntry(entry)
                ? { holdsQueue: true }
                : {})
            } as PromptQueueEntry)
          : entry
      )
    }))
  }

  /**
   * An answer refused before any byte moved goes back to `queued` with its retry schedule. Its
   * receipt is dropped, so the next attempt mints a new operation id and nothing is replayed.
   */
  retryPromptQueueEntryLater(
    rowKey: string,
    entryId: string,
    retry: PromptQueueRetry
  ): PromptQueue | null {
    return this.writeExisting(rowKey, (queue) => ({
      ...queue,
      entries: queue.entries.map((entry) => {
        if (entry.id !== entryId || isPromptQueueEntrySettled(entry)) {
          return entry
        }
        const waiting: PromptQueueEntry = { ...entry, state: 'queued', retry }
        delete waiting.operationId
        delete waiting.deliveryEpoch
        return waiting
      })
    }))
  }

  private replace(queues: PromptQueues, rowKey: string, queue: PromptQueue): PromptQueues {
    // Why here: every queue write passes through, so a steward judgment in flight sees it.
    bumpConversationMutation(rowKey)
    const entries = capPromptQueueEntries(queue.entries)
    const next = { ...queues }
    if (entries.length || queue.recovery) {
      next[rowKey] = { ...queue, entries }
    } else {
      delete next[rowKey]
    }
    return next
  }

  private write(
    rowKey: string,
    source: ConversationSource,
    update: (queue: PromptQueue) => PromptQueue
  ): PromptQueue {
    const context = this[promptQueuePersistenceContext]
    const queues = context.runtime.state.promptQueues ?? {}
    const updated = update(queues[rowKey] ?? emptyPromptQueue(source))
    context.runtime.state.promptQueues = this.replace(queues, rowKey, updated)
    scheduleSave(context.scheduling)
    return structuredClone(
      context.runtime.state.promptQueues[rowKey] ?? { ...updated, entries: [] }
    )
  }

  private writeExisting(
    rowKey: string,
    update: (queue: PromptQueue) => PromptQueue
  ): PromptQueue | null {
    const context = this[promptQueuePersistenceContext]
    const current = context.runtime.state.promptQueues?.[rowKey]
    if (!current) {
      return null
    }
    return this.write(rowKey, current.source, update)
  }
}

export function installPromptQueuePersistenceContext(
  target: object,
  source: PromptQueuePersistence
): void {
  Object.defineProperty(target, promptQueuePersistenceContext, {
    value: source[promptQueuePersistenceContext]
  })
}
