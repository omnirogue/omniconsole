import type { LedgerNowResult, LedgerPublicRow } from '@/lib/session-ledger-types'

export const isLiveLedgerRow = (row: LedgerPublicRow): boolean =>
  row.state === 'running' || row.state === 'idle' || row.state === 'waiting'

export function serverDay(date: string, serverTime: string): string {
  const offset = serverTime.match(/([+-])(\d{2}):(\d{2})$/)
  const minutes = offset
    ? (Number(offset[2]) * 60 + Number(offset[3])) * (offset[1] === '+' ? 1 : -1)
    : 0
  const timestamp = Date.parse(date)
  return Number.isFinite(timestamp)
    ? new Date(timestamp + minutes * 60_000).toISOString().slice(0, 10)
    : ''
}

/**
 * The rows of one section. "Today" is the server's `scope=today` answer, cut in the caller's
 * zone (`X-Omni-Timezone`) — re-cutting it here by the `Z`-suffixed server clock would hide
 * rows of the caller's local day; only the live/finished split is applied.
 */
export function ledgerSectionRows(
  result: LedgerNowResult | null,
  live: boolean
): LedgerPublicRow[] {
  if (!result?.ok) {
    return []
  }
  return result.rows
    .filter((row) => (live ? isLiveLedgerRow(row) : !isLiveLedgerRow(row)))
    .sort((a, b) => Date.parse(b.last_activity_at) - Date.parse(a.last_activity_at))
}
