import type SyncDatabase from '../sqlite/sync-database'

/** How long a pass's writes may stay uncommitted; a crash only costs re-reading them. */
const BATCH_MAX_AGE_MS = 10_000

/**
 * Groups the index's writes into few commits. Every commit flushes a new FTS5 segment and merges
 * older ones, so one commit per file slice rewrote the index many times over (#857).
 */
export class SessionSearchWriteBatch {
  private depth = 0
  private openedAt: number | null = null

  constructor(private readonly db: SyncDatabase) {}

  transaction<T>(work: () => T): T {
    const savepoint = this.depth > 0 ? `s${this.depth}` : null
    this.db.exec(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN')
    this.depth += 1
    try {
      const result = work()
      this.depth -= 1
      this.db.exec(savepoint ? `RELEASE ${savepoint}` : 'COMMIT')
      return result
    } catch (error) {
      this.depth -= 1
      try {
        this.db.exec(savepoint ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK')
      } catch {
        // Why: SQLite auto-rolls back the whole transaction on IOERR/FULL/BUSY; keep the original error.
        this.reset()
      }
      throw error
    }
  }

  begin(): void {
    if (this.openedAt === null && this.depth === 0) {
      this.db.exec('BEGIN')
      this.depth = 1
      this.openedAt = Date.now()
    }
  }

  end(): void {
    if (this.openedAt !== null && this.depth === 1) {
      try {
        this.db.exec('COMMIT')
      } catch (error) {
        // Why: an auto-rolled-back batch has nothing to commit; a live transaction failing must surface.
        if (!/no transaction is active/i.test(String(error))) {
          throw error
        }
      }
      this.reset()
    }
  }

  private reset(): void {
    this.depth = 0
    this.openedAt = null
  }

  /** Commits and reopens a batch open at least `maxAgeMs`, bounding the work a crash loses. */
  roll(maxAgeMs = BATCH_MAX_AGE_MS): void {
    if (this.openedAt !== null && Date.now() - this.openedAt >= maxAgeMs) {
      this.end()
      this.begin()
    }
  }
}
