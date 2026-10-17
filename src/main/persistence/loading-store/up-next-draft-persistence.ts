import {
  UP_NEXT_MAX_DRAFTS,
  type UpNextDraftEntry,
  type UpNextDraftRecord,
  type UpNextDrafts
} from '../../../shared/up-next-draft-schema'
import { upNextRowKey, type UpNextConversationId } from '../../../shared/up-next-types'
import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteSchedulingOperations } from './write-scheduling'
import { scheduleSave } from './write-scheduling'

type UpNextDraftRuntime = Pick<StoreRuntimeState, 'state'> &
  Partial<Pick<StoreRuntimeState, 'flushOrThrow' | 'writesFrozen'>>

const upNextDraftPersistenceContext = Symbol('UpNextDraftPersistence')
type UpNextDraftPersistenceContext = {
  runtime: UpNextDraftRuntime
  scheduling: WriteSchedulingOperations
}

/**
 * Up next blocks the person composed but has not queued yet, kept in the profile state
 * file beside the prompt queue and the session chains.
 *
 * A draft is an intention, not work: it launches nothing, it is not in any plan, and the
 * tick never reads it. It lives on disk for one reason — the composer must still show the
 * same blocks, in the same order, after OmniConsole restarts. Committing them is what
 * turns them into chain steps, and a committed draft is deleted here in the same call.
 *
 * The whole list is replaced on every write: add, edit, reorder, remove and discard are
 * all "this is the list now", computed by the caller that knows the order rules.
 *
 * Composing is debounced like every other intention. The write that finishes a COMMIT is not:
 * the plan it belongs to is already on disk, so `replaceUpNextDraftsAndFlush` puts the draft
 * removal and the review's own `held` markers there in the same moment. A crash in the second
 * between them is what brings executed work back as drafts, or loses the continuation.
 */
export class UpNextDraftPersistence {
  readonly [upNextDraftPersistenceContext]: UpNextDraftPersistenceContext

  constructor(runtime: UpNextDraftRuntime, scheduling: WriteSchedulingOperations) {
    this[upNextDraftPersistenceContext] = { runtime, scheduling }
  }

  listUpNextDrafts(): UpNextDrafts {
    return structuredClone(this[upNextDraftPersistenceContext].runtime.state.upNextDrafts ?? {})
  }

  readUpNextDrafts(rowKey: string): UpNextDraftRecord | null {
    const record = this[upNextDraftPersistenceContext].runtime.state.upNextDrafts?.[rowKey]
    return record ? structuredClone(record) : null
  }

  /** The person's whole draft list for one conversation; an empty list clears the record. */
  replaceUpNextDrafts(
    subject: UpNextConversationId,
    entries: readonly UpNextDraftEntry[]
  ): UpNextDraftRecord {
    const written = this.writeDrafts(subject, entries)
    scheduleSave(this[upNextDraftPersistenceContext].scheduling)
    return written.record
  }

  /**
   * The same write, on disk before it returns: the half of a commit that clears what was
   * queued and marks what a review is holding. A failure leaves the store exactly as it was.
   */
  replaceUpNextDraftsAndFlush(
    subject: UpNextConversationId,
    entries: readonly UpNextDraftEntry[]
  ): UpNextDraftRecord {
    const context = this[upNextDraftPersistenceContext]
    if (!context.runtime.flushOrThrow || context.runtime.writesFrozen) {
      throw new Error('Durable Up next persistence is unavailable on this host.')
    }
    const written = this.writeDrafts(subject, entries)
    try {
      context.runtime.flushOrThrow()
    } catch (error) {
      context.runtime.state.upNextDrafts = written.previous
      throw error
    }
    return written.record
  }

  /** Named for this domain: the Store merges every domain's prototype into one object. */
  private writeDrafts(
    subject: UpNextConversationId,
    entries: readonly UpNextDraftEntry[]
  ): { record: UpNextDraftRecord; previous: UpNextDrafts } {
    if (entries.length > UP_NEXT_MAX_DRAFTS) {
      throw new Error('This conversation already has the most new blocks it can hold.')
    }
    const context = this[upNextDraftPersistenceContext]
    const rowKey = upNextRowKey(subject)
    const previous = { ...context.runtime.state.upNextDrafts }
    const drafts = { ...previous }
    const record: UpNextDraftRecord = {
      subject,
      entries: structuredClone([...entries]),
      updatedAt: Date.now()
    }
    if (record.entries.length) {
      drafts[rowKey] = record
    } else {
      delete drafts[rowKey]
    }
    context.runtime.state.upNextDrafts = drafts
    return { record: structuredClone(record), previous }
  }
}

export function installUpNextDraftPersistenceContext(
  target: object,
  source: UpNextDraftPersistence
): void {
  Object.defineProperty(target, upNextDraftPersistenceContext, {
    value: source[upNextDraftPersistenceContext]
  })
}
