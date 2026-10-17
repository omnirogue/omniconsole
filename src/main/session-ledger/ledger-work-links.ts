import type { LedgerEventDetail } from '../../shared/session-ledger-contract'
import { extractSessionWorkLinks } from '../../shared/session-work-links'
import type { LedgerPaneEntry, LedgerPaneRegistry } from './ledger-identity'

/** Rows whose sent links are remembered; the console keeps one entry per document anyway. */
export const LEDGER_WORK_LINK_ROWS_MAX = 500

/**
 * The Slite docs, omnios pages and Claude artifacts a finished reply names, as its row's
 * `work_link` events, so the omnios Work log finds an archived session's work by day. Each
 * document goes once per row; a pane without a live, started row records nothing.
 */
export class LedgerWorkLinks {
  private readonly sent = new Map<string, Set<string>>()

  constructor(
    private readonly registry: LedgerPaneRegistry,
    private readonly emit: (entry: LedgerPaneEntry, event: LedgerEventDetail) => void
  ) {}

  noteReply(paneKey: string, reply: string, apiOrigin: string | null): void {
    const entry = this.registry.get(paneKey)
    if (!entry || !entry.started || entry.ended || !reply) {
      return
    }
    const sent = this.sent.get(entry.ledgerId) ?? new Set<string>()
    for (const url of extractSessionWorkLinks(reply, apiOrigin)) {
      if (!sent.has(url)) {
        sent.add(url)
        this.emit(entry, { kind: 'work_link', detail: { url } })
      }
    }
    // Why delete first: Map order is insertion order, so the least recently linked row goes first.
    this.sent.delete(entry.ledgerId)
    this.sent.set(entry.ledgerId, sent)
    const oldest = this.sent.keys().next().value
    if (this.sent.size > LEDGER_WORK_LINK_ROWS_MAX && oldest !== undefined) {
      this.sent.delete(oldest)
    }
  }
}
