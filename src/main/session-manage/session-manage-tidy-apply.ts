import type { SessionTidyResult, SessionTidyRow } from '../../shared/session-manage-types'
import type { SessionTidyVerdict } from './session-manage-tidy'

export type SessionTidyApplyDeps = {
  /** The target's verdict read again now, or null when it left the sidebar. */
  recheck: (row: SessionTidyRow) => Promise<SessionTidyVerdict | null>
  /** The existing archive path (`sessionFolders.mutate`): audit line and Undo toast included. */
  archive: (row: SessionTidyRow) => Promise<{ auditError?: string }>
  /** Delete mode: the existing delete path, the same audit line and Undo toast. */
  delete?: (row: SessionTidyRow) => Promise<{ auditError?: string }>
}

/**
 * Archives (or, in delete mode, deletes) exactly the plan's rows for that action, each re-checked
 * just before; nothing else changes.
 */
export async function applySessionTidy(
  rows: readonly SessionTidyRow[],
  deps: SessionTidyApplyDeps
): Promise<{ rows: SessionTidyRow[]; applied: NonNullable<SessionTidyResult['applied']> }> {
  const applied = { archived: 0, skipped: 0, failed: 0, ...(deps.delete ? { deleted: 0 } : {}) }
  const out: SessionTidyRow[] = []
  for (const row of rows) {
    const deleting = row.action === 'delete' && !!deps.delete
    if (row.action !== 'archive' && !deleting) {
      out.push(row)
      continue
    }
    try {
      const fresh = await deps.recheck(row)
      // Why the flag too: the delete is sent with the plan's --unverified, never a newer one.
      if (!fresh || fresh.action !== row.action || !!fresh.unverified !== !!row.unverified) {
        applied.skipped += 1
        out.push({
          ...row,
          outcome: 'skipped',
          outcomeReason: fresh
            ? `Changed since the plan: ${fresh.reason}`
            : 'It left the sidebar since the plan.'
        })
        continue
      }
      const { auditError } = deleting ? await deps.delete!(row) : await deps.archive(row)
      if (deleting) {
        applied.deleted = (applied.deleted ?? 0) + 1
      } else {
        applied.archived += 1
      }
      out.push({
        ...row,
        outcome: deleting ? 'deleted' : 'archived',
        ...(auditError ? { auditError } : {})
      })
    } catch (error) {
      applied.failed += 1
      out.push({
        ...row,
        outcome: 'failed',
        outcomeReason: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return { rows: out, applied }
}
