import type { LedgerLocalSession, LedgerPeer, LedgerPublicRow } from '@/lib/session-ledger-types'

export type LedgerCollision = {
  peer: LedgerPeer
  local: LedgerLocalSession
  day: string
}

/**
 * The server already chose the peers (contract §2/§10: it excludes the exact (employee, ledger)
 * row, keeps only live candidates and folds attempts into one ledger row), so the client keeps
 * every peer except the local session itself. A second local pane or the same employee is a
 * real peer; ownership never needs the bounded `now` rows.
 */
export function eligibleCollisionPeer(
  peer: LedgerPeer,
  local: LedgerLocalSession,
  muted: ReadonlySet<string>
): boolean {
  if (local.repo && muted.has(local.repo)) {
    return false
  }
  return peer.ledger_id !== local.ledgerId
}

/** Who the peer is: the roster row when it is on the page, else the server's peer payload. */
export function collisionPeerName(peer: LedgerPeer, rows: LedgerPublicRow[]): string | null {
  const row = rows.find((candidate) => candidate.ledger_id === peer.ledger_id)
  // Why: '' is not nullish; a blank name must not win over a real one further down the chain.
  for (const candidate of [row?.employee_name, peer.employee_name, peer.employee_id]) {
    const name = candidate?.trim()
    if (name) {
      return name
    }
  }
  return null
}
