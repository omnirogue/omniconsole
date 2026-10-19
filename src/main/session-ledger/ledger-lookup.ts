import { toSshExecutionHostId } from '../../shared/execution-host'
import type { LedgerPaneRegistry } from './ledger-identity'

let activeRegistry: LedgerPaneRegistry | null = null

/** The service installs its registry here so other main modules can look ids up without importing it. */
export function setActiveLedgerPaneRegistry(registry: LedgerPaneRegistry | null): void {
  activeRegistry = registry
}

/** The pane's ledger id (`als_…`), or null when the pane has no row yet. */
export function ledgerIdForPane(paneId: string): string | null {
  return activeRegistry?.get(paneId)?.ledgerId ?? null
}

/** The pane's ledger id and provider conversation as the registry knows them now. */
export function ledgerIdentityForPane(paneId: string): {
  ledgerId?: string
  nativeSessionId?: string
} {
  const entry = activeRegistry?.get(paneId)
  return {
    ...(entry?.ledgerId ? { ledgerId: entry.ledgerId } : {}),
    ...(entry?.nativeSessionId ? { nativeSessionId: entry.nativeSessionId } : {})
  }
}

/**
 * Lookup by any session handle another lane holds: a pane key, a PTY id, or the
 * provider's native session id (a Claude session uuid, a Codex thread id).
 */
export function ledgerIdForSession(sessionKey: string): string | null {
  if (!activeRegistry || !sessionKey) {
    return null
  }
  const entry =
    activeRegistry.get(sessionKey) ??
    activeRegistry.byPtyId(sessionKey) ??
    activeRegistry.byNativeSessionId(sessionKey)
  return entry?.ledgerId ?? null
}

/** A persisted identity can recover a task link without claiming that its process is live. */
export function ledgerSourceForSession(sessionKey: string, principal: string) {
  const entry = activeRegistry?.get(sessionKey) ?? activeRegistry?.byLedgerId(sessionKey)
  if (!entry || entry.account !== principal) {
    return null
  }
  return {
    paneKey: entry.paneKey,
    ledgerId: entry.ledgerId,
    account: entry.account,
    attemptId: entry.attemptId,
    ptyId: entry.ptyId,
    nativeSessionId: entry.nativeSessionId,
    remote: entry.remote
  }
}

/** The pane (and provider conversation) a ledger id names on this desktop, live or ended; null when unknown. */
export function paneForLedgerId(
  ledgerId: string
): { paneKey: string; nativeSessionId?: string; executionHostId?: string } | null {
  const entry = activeRegistry?.byLedgerId(ledgerId)
  if (!entry) {
    return null
  }
  return {
    paneKey: entry.paneKey,
    ...(entry.connectionId !== undefined
      ? { executionHostId: entry.connectionId ? toSshExecutionHostId(entry.connectionId) : 'local' }
      : {}),
    ...(entry.nativeSessionId ? { nativeSessionId: entry.nativeSessionId } : {})
  }
}
