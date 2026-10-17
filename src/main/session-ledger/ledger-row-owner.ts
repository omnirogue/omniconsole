import type { LedgerPaneEntry, LedgerPaneRegistry } from './ledger-identity'

/** How long a removed row's ownerless batches stay recognisable, so only age gives them up. */
export const LEDGER_REMOVED_ROW_MEMORY_MS = 24 * 60 * 60_000

/**
 * Who this process has seen signed in — every sighting, counted — and which rows it stamped
 * itself. Together they bound the one case where an ownerless row may take an owner late:
 * a row this run stamped while nobody was signed in, when the only principal seen since is
 * the one asking — whether or not its PTY still lives (the process ran here, in this run).
 * Restored rows and rows of other runs are never claimed; a row seen alongside a different
 * principal is never claimed.
 */
export class LedgerOwnerLedger {
  /** Bumped on every non-null sighting; a row's stamp and each principal's last sighting are counters. */
  private observations = 0
  private readonly lastSeen = new Map<string, number>()
  private readonly stampedAt = new Map<string, number>()
  private readonly removedAt = new Map<string, number>()

  /** Record the principal as seen; returns it unchanged. */
  observe(principal: string | null): string | null {
    // Why: every sighting counts, so anyone seen after a row's stamp — even someone also seen
    // before it — is distinguishable from the one person who may own that row.
    if (principal) {
      this.observations += 1
      this.lastSeen.set(principal, this.observations)
    }
    return principal
  }

  /** The pane's row was stamped by this run, now. */
  stamped(paneKey: string): void {
    this.stampedAt.set(paneKey, this.observations)
  }

  /** Stamp only a pane this run has not stamped yet (a row first seen through hooks). */
  stampedIfNew(paneKey: string): void {
    if (!this.stampedAt.has(paneKey)) {
      this.stamped(paneKey)
    }
  }

  /** The pane's row was removed; its ownerless batches stay recognisable until they age out. */
  forget(paneKey: string, ledgerId: string, now = Date.now()): void {
    this.stampedAt.delete(paneKey)
    this.removedAt.set(ledgerId, now)
  }

  /** Whether a row is still known here: live in the registry, or removed within the memory window. */
  rowKnown(registry: LedgerPaneRegistry, ledgerId: string, now = Date.now()): boolean {
    if (registry.byLedgerId(ledgerId)) {
      return true
    }
    const removed = this.removedAt.get(ledgerId)
    if (removed === undefined) {
      return false
    }
    if (now - removed > LEDGER_REMOVED_ROW_MEMORY_MS) {
      this.removedAt.delete(ledgerId)
      return false
    }
    return true
  }

  /**
   * Whether the row `ledgerId` is (or may now become) `account`'s. Read-only for owned rows;
   * an ownerless row is assigned only under the narrow rule above.
   */
  claim(registry: LedgerPaneRegistry, ledgerId: string, account: string): boolean {
    const entry = registry.byLedgerId(ledgerId)
    if (!entry) {
      return false
    }
    if (entry.account !== null) {
      return entry.account === account
    }
    const since = this.stampedAt.get(entry.paneKey)
    if (since === undefined || entry.attemptId === '' || entry.restored) {
      return false
    }
    const seenSince = [...this.lastSeen].filter(([, at]) => at > since).map(([who]) => who)
    if (seenSince.length > 1 || (seenSince.length === 1 && seenSince[0] !== account)) {
      return false
    }
    registry.update(entry.paneKey, { account })
    return true
  }
}

/**
 * Whether a spawn by `owner` must get its own row instead of continuing `previous`: the row
 * belongs to someone else, or it has no owner and is not this very spawn being re-stamped
 * (a restored or otherwise ownerless row is never adopted by whoever signs in next).
 */
export function needsOwnRow(
  previous: Pick<LedgerPaneEntry, 'account' | 'ptyId' | 'pendingStart'>,
  owner: string,
  ptyId: string | null
): boolean {
  if (previous.account !== null) {
    return previous.account !== owner
  }
  const sameSpawn = ptyId !== null && previous.ptyId === ptyId && previous.pendingStart !== null
  return !sameSpawn
}
