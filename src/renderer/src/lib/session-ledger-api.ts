import type { SessionLedgerApi } from './session-ledger-types'

export function getSessionLedgerApi(): SessionLedgerApi | undefined {
  return typeof window === 'undefined'
    ? undefined
    : (window.api as (typeof window.api & { sessionLedger?: SessionLedgerApi }) | undefined)
        ?.sessionLedger
}
