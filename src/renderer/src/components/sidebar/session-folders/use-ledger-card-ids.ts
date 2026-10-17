import { useCallback, useEffect, useState } from 'react'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { useAppStore } from '@/store'
import type { LedgerLocalSession } from '../../../../../shared/session-ledger-contract'

const NO_CARDS: ReadonlyMap<string, string> = new Map()
/** A refused read repairs itself rather than waiting for the person to toggle the lens. */
const LEDGER_RETRY_DELAY_MS = 5_000
const LEDGER_RETRY_LIMIT = 3

/**
 * `ready` is the only answer that means "this is what the ledger says". `error` and
 * `unsupported` both mean unknown, and must never read as "these panes serve no task".
 */
export type LedgerCardIdsStatus = 'idle' | 'loading' | 'ready' | 'error' | 'unsupported'

export type LedgerCardIds = {
  cards: ReadonlyMap<string, string>
  status: LedgerCardIdsStatus
  /** The ledger's answer is not known; an empty map here is absence of evidence. */
  unknown: boolean
  retry: () => void
}

/** Pane key → hub card for this device's live ledger sessions that carry one. */
export function ledgerCardIdsByPane(rows: readonly LedgerLocalSession[]): Map<string, string> {
  const cards = new Map<string, string>()
  for (const row of rows) {
    if (row.cardId?.startsWith('btk_')) {
      cards.set(row.paneId, row.cardId)
    }
  }
  return cards
}

/** Read-only: the ledger's card per pane, subscribed only while the task lens is on. */
export function useLedgerCardIds(enabled: boolean): LedgerCardIds {
  // Why: the ledger belongs to the signed-in profile, so a switch invalidates every card.
  const accountScope = useAppStore(selectConsoleAccountScope)
  const [attempt, setAttempt] = useState(0)
  const [retryPending, setRetryPending] = useState(false)
  const [state, setState] = useState<{
    cards: ReadonlyMap<string, string>
    status: LedgerCardIdsStatus
  }>({ cards: NO_CARDS, status: 'idle' })
  const retry = useCallback(() => setAttempt((count) => count + 1), [])
  // Adjusted during render, not in an effect: an effect lets one paint show the
  // previous scope's retry state before the reset lands.
  const scopeKey = `${String(enabled)}|${accountScope ?? ''}`
  const [prevScopeKey, setPrevScopeKey] = useState(scopeKey)
  if (prevScopeKey !== scopeKey) {
    setPrevScopeKey(scopeKey)
    setAttempt(0)
    setRetryPending(false)
  }
  useEffect(() => {
    if (!enabled) {
      setState({ cards: NO_CARDS, status: 'idle' })
      return
    }
    // Why: cards from an earlier lens session or account are not evidence about this one.
    setState({ cards: NO_CARDS, status: 'loading' })
    const ledger = window.api?.sessionLedger
    if (!ledger) {
      setState({ cards: NO_CARDS, status: 'unsupported' })
      return
    }
    let live = true
    const apply = (rows: readonly LedgerLocalSession[]): void => {
      if (live) {
        setState({ cards: ledgerCardIdsByPane(rows), status: 'ready' })
      }
    }
    void ledger
      .localSessions()
      .then(apply)
      .catch((error: unknown) => {
        if (!live) {
          return
        }
        // Why: a refused read is "unknown", not an empty ledger — say so, and try again.
        console.warn('[session-sidebar] ledger sessions unavailable', error)
        setState({ cards: NO_CARDS, status: 'error' })
        if (attempt < LEDGER_RETRY_LIMIT) {
          setRetryPending(true)
        }
      })
    const unsubscribe = ledger.onLocalSessionsChanged(apply)
    return () => {
      live = false
      unsubscribe()
    }
  }, [enabled, accountScope, attempt])
  // The timer is created at the top of its own effect so the cleanup always owns it;
  // scheduling it inside the failed read's catch left it outside React's reach.
  useEffect(() => {
    if (!retryPending) {
      return
    }
    const timer = setTimeout(() => {
      setRetryPending(false)
      setAttempt((count) => count + 1)
    }, LEDGER_RETRY_DELAY_MS)
    return () => clearTimeout(timer)
  }, [retryPending])
  return { cards: state.cards, status: state.status, unknown: state.status !== 'ready', retry }
}
