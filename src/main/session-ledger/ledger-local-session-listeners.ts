import type { LedgerLocalSession } from '../../shared/session-ledger-contract'

/** The service-level fan-out of local-session changes; outlives any registry it is fed from. */
export class LedgerLocalSessionListeners {
  private readonly listeners = new Set<(rows: LedgerLocalSession[]) => void>()

  add(listener: (rows: LedgerLocalSession[]) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  notify(rows: LedgerLocalSession[]): void {
    for (const listener of this.listeners) {
      try {
        listener(rows)
      } catch {
        // one listener must not strand the rest
      }
    }
  }
}
