import type SyncDatabase from '../sqlite/sync-database'
import { toSessionRow, type Row, type SessionRow } from './session-search-index-rows'
import { MODEL_SUMMARY_MAX_CHARS } from './session-summary-prompt'

export type SummaryCandidateWindow = {
  limit: number
  minBytes: number
  activeSince: number
  idleBefore?: number
}

/** Refresh settled changes and legacy formats within the existing per-round capacity budget. */
export function findSummaryCandidates(
  db: SyncDatabase,
  args: SummaryCandidateWindow
): SessionRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM sessions WHERE kind = 'work' AND text_bytes >= ? AND last_ts >= ?
     AND (summary_source IS NOT 'model' OR text_bytes > summary_basis_bytes * 1.25 + 8000
          OR (instr(summary, char(10) || 'Title:') = 0 AND substr(summary, 1, 6) != 'Title:')
          OR (text_bytes != summary_basis_bytes AND last_ts <= ?)
          OR (instr(summary, char(10) || 'State:') = 0 AND substr(summary, ?, 1) = '…'))
     ORDER BY last_ts DESC LIMIT ?`
    )
    .all(
      args.minBytes,
      args.activeSince,
      args.idleBefore ?? 0,
      MODEL_SUMMARY_MAX_CHARS,
      args.limit
    ) as Row[]
  return rows.map(toSessionRow)
}
