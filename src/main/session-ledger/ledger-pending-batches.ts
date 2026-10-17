import {
  LEDGER_BATCH_MAX_BYTES,
  LEDGER_BATCH_MAX_EVENTS,
  type LedgerBatchEnvelope,
  type LedgerEvent
} from '../../shared/session-ledger-contract'
import { byteLength, PRESERVED_KINDS } from './ledger-spill-file'

export type QueuedBatch = {
  account: string | null
  envelope: LedgerBatchEnvelope
  events: LedgerEvent[]
  /** Console 4xx answers so far; the batch is given up after a bounded number. */
  rejections?: number
  /** Ownerless only: when it was first queued, so it can be aged out rather than held forever. */
  heldSince?: number
}

/**
 * Consecutive slices of `events` whose serialized batch stays within the byte cap; an event
 * that alone exceeds it travels by itself rather than being dropped. Order is preserved.
 */
export function chunkEvents(
  envelope: LedgerBatchEnvelope,
  events: LedgerEvent[],
  maxBytes = LEDGER_BATCH_MAX_BYTES
): LedgerEvent[][] {
  const chunks: LedgerEvent[][] = []
  let current: LedgerEvent[] = []
  for (const event of events) {
    const candidate = [...current, event]
    if (current.length > 0 && byteLength({ ...envelope, events: candidate }) > maxBytes) {
      chunks.push(current)
      current = [event]
    } else {
      current = candidate
    }
  }
  if (current.length > 0) {
    chunks.push(current)
  }
  return chunks
}

export function batchKey(
  envelope: Pick<LedgerBatchEnvelope, 'ledger_id' | 'attempt_id'>,
  account: string | null
): string {
  return `${envelope.ledger_id}\0${envelope.attempt_id}\0${account ?? ''}`
}

/**
 * The in-memory batches, keyed by row, attempt and the account they were queued under.
 * Bounded to the contract's event cap; oldest expendable events go first.
 */
export class LedgerPendingBatches {
  private readonly batches = new Map<string, QueuedBatch>()

  get size(): number {
    return this.batches.size
  }

  get(key: string): QueuedBatch | undefined {
    return this.batches.get(key)
  }

  set(key: string, batch: QueuedBatch): void {
    this.batches.set(key, batch)
  }

  delete(key: string): void {
    this.batches.delete(key)
  }

  entries(): [string, QueuedBatch][] {
    return [...this.batches.entries()]
  }

  values(): QueuedBatch[] {
    return [...this.batches.values()]
  }

  eventCount(): number {
    let count = 0
    for (const batch of this.batches.values()) {
      count += batch.events.length
    }
    return count
  }

  /** Events queued under `account` (the current person's own budget). */
  eventCountFor(account: string | null): number {
    let count = 0
    for (const batch of this.batches.values()) {
      if (batch.account === account) {
        count += batch.events.length
      }
    }
    return count
  }

  /**
   * Remove the ownerless batches whose row is gone from this host (per `rowKnown`) or that
   * have been held since before `cutoff`; returns how many were removed.
   */
  discardOrphans(
    rowKnown: ((envelope: LedgerBatchEnvelope) => boolean) | undefined,
    cutoff: number
  ): number {
    let removed = 0
    for (const [key, batch] of this.entries()) {
      if (batch.account !== null) {
        continue
      }
      let known = true
      try {
        known = rowKnown ? rowKnown(batch.envelope) : true
      } catch {
        known = true
      }
      if (!known || (batch.heldSince ?? Number.POSITIVE_INFINITY) < cutoff) {
        this.batches.delete(key)
        removed += 1
      }
    }
    return removed
  }

  /**
   * Remove and return the batches sendable under `account`; report whether any are held.
   * Ownerless batches (queued before sign-in resolved) and another person's batches are held,
   * never sent under `account` and never dropped (contract §0b.11).
   */
  takeForAccount(account: string | null): { batches: [string, QueuedBatch][]; held: boolean } {
    const batches: [string, QueuedBatch][] = []
    let held = false
    for (const [key, batch] of this.batches) {
      if (account !== null && batch.account === account) {
        batches.push([key, batch])
        this.batches.delete(key)
      } else {
        held = true
      }
    }
    return { batches, held }
  }

  /**
   * Bind the ownerless batches `claim` vouches for to `account`, merging into that account's
   * batch for the same row when one exists (the ownerless events are the older ones).
   */
  bindOwnerless(
    account: string,
    claim: (envelope: Pick<LedgerBatchEnvelope, 'ledger_id' | 'attempt_id'>) => boolean
  ): number {
    let bound = 0
    for (const [key, batch] of this.entries()) {
      if (batch.account !== null || !claim(batch.envelope)) {
        continue
      }
      const ownedKey = batchKey(batch.envelope, account)
      const owned = this.batches.get(ownedKey)
      if (owned) {
        this.batches.delete(key)
        owned.events = [...batch.events, ...owned.events]
      } else {
        // Why: the batch keeps its place in line — its events predate anything queued since.
        this.replaceKey(key, ownedKey, { account, envelope: batch.envelope, events: batch.events })
      }
      bound += 1
    }
    if (bound > 0) {
      this.bound(account)
    }
    return bound
  }

  /** Append one event; a file_write replaces an earlier one for the same path in its batch. */
  append(
    key: string,
    account: string | null,
    envelope: LedgerBatchEnvelope,
    event: LedgerEvent,
    now = Date.now()
  ): void {
    let batch = this.batches.get(key)
    if (!batch) {
      batch = { account, envelope, events: [], ...(account === null ? { heldSince: now } : {}) }
      this.batches.set(key, batch)
    } else {
      // Why: the row's identity fields may have been learned since (model, native id, branch).
      batch.envelope = envelope
    }
    if (event.kind === 'file_write') {
      const path = event.detail.path
      batch.events = batch.events.filter(
        (queued) => !(queued.kind === 'file_write' && queued.detail.path === path)
      )
    }
    batch.events.push(event)
    this.bound(account, { key, event })
  }

  /**
   * A failed batch goes back to the front so it is delivered (or dropped) first; batches
   * requeued one after another keep their original order among themselves.
   */
  requeueFront(key: string, batch: QueuedBatch): void {
    const newer = this.batches.get(key)
    const merged: QueuedBatch = newer
      ? {
          account: batch.account,
          envelope: newer.envelope,
          events: [...batch.events, ...newer.events],
          ...(batch.rejections ? { rejections: batch.rejections } : {})
        }
      : batch
    const rest = this.entries().filter(([entryKey]) => entryKey !== key)
    this.batches.clear()
    this.batches.set(key, merged)
    for (const [entryKey, entry] of rest) {
      this.batches.set(entryKey, entry)
    }
    this.bound(batch.account)
  }

  /**
   * A batch the console refused goes to the back: it is retried after everything else, and
   * never stands between other rows' batches and the console.
   */
  requeueBack(key: string, batch: QueuedBatch): void {
    const newer = this.batches.get(key)
    this.batches.delete(key)
    this.batches.set(
      key,
      newer
        ? { ...batch, envelope: newer.envelope, events: [...batch.events, ...newer.events] }
        : batch
    )
    this.bound(batch.account)
  }

  /**
   * Put the batches a run could not deliver back at the front, in the order they were taken,
   * ahead of anything queued meanwhile.
   */
  requeueFrontInOrder(failed: [string, QueuedBatch][]): void {
    for (let index = failed.length - 1; index >= 0; index -= 1) {
      const [key, batch] = failed[index]!
      this.requeueFront(key, batch)
    }
  }

  /**
   * Two budgets of the contract's event cap: the appending account's own batches, and
   * everything held for other people (or nobody). Neither consumes the other's room, so a
   * held batch never costs the signed-in person an event and vice versa. Within a budget,
   * expendable events go first, then starts/stops; a new expendable event that would only fit
   * by evicting its own account's start/stop is refused instead.
   */
  private bound(account: string | null, incoming?: { key: string; event: LedgerEvent }): void {
    while (this.eventCountFor(account) > LEDGER_BATCH_MAX_EVENTS) {
      if (this.dropOldest(false, account, true)) {
        continue
      }
      if (incoming && !PRESERVED_KINDS.has(incoming.event.kind) && this.remove(incoming)) {
        continue
      }
      if (!this.dropOldest(true, account, true)) {
        return
      }
    }
    while (this.eventCount() - this.eventCountFor(account) > LEDGER_BATCH_MAX_EVENTS) {
      if (!this.dropOldest(false, account, false) && !this.dropOldest(true, account, false)) {
        return
      }
    }
  }

  private replaceKey(oldKey: string, newKey: string, batch: QueuedBatch): void {
    const rest = this.entries()
    this.batches.clear()
    for (const [key, entry] of rest) {
      this.batches.set(key === oldKey ? newKey : key, key === oldKey ? batch : entry)
    }
  }

  private remove(target: { key: string; event: LedgerEvent }): boolean {
    const batch = this.batches.get(target.key)
    const index = batch?.events.indexOf(target.event) ?? -1
    if (!batch || index === -1) {
      return false
    }
    batch.events.splice(index, 1)
    if (batch.events.length === 0) {
      this.batches.delete(target.key)
    }
    return true
  }

  private dropOldest(preservedToo: boolean, account: string | null, own: boolean): boolean {
    for (const [key, batch] of this.batches) {
      if ((batch.account === account) !== own) {
        continue
      }
      const index = batch.events.findIndex(
        (event) => preservedToo || !PRESERVED_KINDS.has(event.kind)
      )
      if (index !== -1) {
        batch.events.splice(index, 1)
        if (batch.events.length === 0) {
          this.batches.delete(key)
        }
        return true
      }
    }
    return false
  }
}
