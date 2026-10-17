import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type {
  RuntimeSessionWorkflowRecord,
  RuntimeSessionWorkflowRecordSet,
  SessionWorkflowRecordPublication
} from '../../shared/session-workflow-records'

/**
 * This runtime's own workflow conversations, as its window last published them (session counts,
 * step 9). One generation per runtime incarnation and one revision that moves on every change to
 * the set or its completeness, so a receiver orders whole sets and a late copy can never restore
 * what a newer one removed. Complete only while the window that published the whole set is still
 * attached: at startup, headless, or after the window closed an omission proves nothing.
 */
export class SessionWorkflowRecordStore {
  readonly generation = randomUUID()
  private revision = 0
  private complete = false
  private rendererGeneration: string | null = null
  private byWorktree: Record<string, RuntimeSessionWorkflowRecord[]> = {}
  private readonly listeners = new Set<() => void>()

  /** Replaces the whole set with the window's publication; true when anything changed. */
  publish(publication: SessionWorkflowRecordPublication): boolean {
    this.rendererGeneration = publication.rendererGeneration
    const byWorktree = Object.fromEntries(
      Object.entries(publication.recordsByWorktree).filter(([, records]) => records.length > 0)
    )
    if (this.complete === publication.complete && isDeepStrictEqual(this.byWorktree, byWorktree)) {
      return false
    }
    this.byWorktree = byWorktree
    this.complete = publication.complete
    this.changed()
    return true
  }

  /**
   * The publishing window went away (closed, or handed authority back to the headless graph).
   * Its last records stay listed, but the set no longer vouches for anything it omits.
   */
  markPublisherGone(): void {
    this.rendererGeneration = null
    if (this.complete) {
      this.complete = false
      this.changed()
    }
  }

  /** The value a negotiated client receives: the whole set at the current revision. */
  snapshot(): RuntimeSessionWorkflowRecordSet {
    return {
      generation: this.generation,
      revision: this.revision,
      complete: this.complete,
      recordsByWorktree: this.byWorktree
    }
  }

  isComplete(): boolean {
    return this.complete
  }

  findRecord(worktreeId: string, tabId: string): RuntimeSessionWorkflowRecord | null {
    return this.byWorktree[worktreeId]?.find((record) => record.tabId === tabId) ?? null
  }

  getRendererGeneration(): string | null {
    return this.rendererGeneration
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private changed(): void {
    this.revision += 1
    for (const listener of this.listeners) {
      listener()
    }
  }
}
