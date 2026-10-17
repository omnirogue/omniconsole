import type { QueuedBatch } from './ledger-pending-batches'
import {
  boundSpill,
  readSpillFile,
  SPILL_VERSION,
  type LedgerSpillStore,
  type SpilledBatch,
  type SpillFile
} from './ledger-spill-file'

export type SpillLoad =
  | { state: 'ok'; batches: SpilledBatch[] }
  | { state: 'empty' }
  /** The file could not be read or set aside; it may still hold real batches, so it is left alone. */
  | { state: 'unavailable' }

/**
 * The queue's disk copy. Reads never throw to the queue; a file this version cannot read is
 * set aside (never deleted) so held batches are not lost indistinguishably from "nothing".
 * While the file is unavailable, nothing is written over it and nothing removes it.
 */
export class LedgerSpillJournal {
  private blocked = false

  constructor(
    private readonly store: LedgerSpillStore | null | undefined,
    private readonly warn: (message: string) => void
  ) {}

  load(): SpillLoad {
    if (!this.store) {
      return { state: 'empty' }
    }
    let raw: unknown
    try {
      raw = this.store.read()
    } catch (error) {
      this.warn(`spill read failed: ${error instanceof Error ? error.message : String(error)}`)
      return this.setAside('unreadable')
    }
    if (raw === null || raw === undefined) {
      this.blocked = false
      return { state: 'empty' }
    }
    const batches = readSpillFile(raw)
    if (batches === null) {
      this.warn('spill file not understood; set aside')
      return this.setAside('unreadable')
    }
    this.blocked = false
    return { state: 'ok', batches }
  }

  /** Write the queue's state, bounded, with the current account's batches giving way first. */
  save(queued: QueuedBatch[], current: string | null): void {
    if (!this.store || this.blocked) {
      return
    }
    try {
      const batches = boundSpill(
        queued.map((batch) => ({
          account: batch.account,
          batch: { ...batch.envelope, events: batch.events },
          ...(batch.heldSince ? { heldSince: new Date(batch.heldSince).toISOString() } : {})
        })),
        undefined,
        current
      )
      if (batches.length === 0) {
        this.store.remove()
        return
      }
      this.store.write({ version: SPILL_VERSION, batches } satisfies SpillFile)
    } catch (error) {
      this.warn(`spill write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  remove(): void {
    if (this.blocked) {
      return
    }
    try {
      this.store?.remove()
    } catch {
      // a stale spill re-drains as duplicates, which the console ignores by seq
    }
  }

  /** Rename the file out of the way; if even that fails, block writes so it survives. */
  private setAside(reason: string): SpillLoad {
    try {
      this.store?.quarantine(reason)
      this.blocked = false
    } catch (error) {
      this.warn(
        `spill quarantine failed: ${error instanceof Error ? error.message : String(error)}`
      )
      this.blocked = true
    }
    return { state: 'unavailable' }
  }
}
