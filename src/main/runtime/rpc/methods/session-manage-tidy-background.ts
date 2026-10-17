// `session tidy --delete --include <pane>` for a terminal that runs in the background, not in a
// window: re-checked at apply time, then ended through the audited path `omni terminal close`
// uses, with the run's reason and request recorded like every other tidy delete.

import type { BackgroundRuntimeTerminal } from '../../../../shared/background-runtime-terminal'
import type { SessionManageActor, SessionTidyRow } from '../../../../shared/session-manage-types'
import {
  backgroundTidyKey,
  classifyBackgroundTidy,
  type BackgroundTidyOptions
} from '../../../session-manage/session-manage-background-terminals'
import type { SessionTidyVerdict } from '../../../session-manage/session-manage-tidy'
import {
  backgroundEndSummary,
  endBackgroundRuntimeTerminal,
  type BackgroundEndContext
} from '../../../session-manage/session-manage-background-end'
import { recordSessionAction } from './session-manage-support'
import type { SessionManageProvenance } from './session-manage-schemas'

export const BACKGROUND_TIDY_GONE =
  'It no longer runs in the background outside a window, so tidy leaves it alone.'

/** Plans and applies tidy's background rows against what the runtime lists now. */
export function createBackgroundTidyApply(
  context: BackgroundEndContext,
  planned: readonly BackgroundRuntimeTerminal[] | null,
  plannedRows: readonly SessionTidyRow[],
  options: BackgroundTidyOptions
) {
  // Why the planned rows: a sidebar row sharing a background pane key is never routed here.
  const rowKeys = new Set(plannedRows.map((row) => row.paneKey ?? row.tabId))
  const plannedByKey = new Map(
    (planned ?? []).flatMap((terminal) => {
      const key = backgroundTidyKey(terminal)
      return key && rowKeys.has(key) ? [[key, terminal] as const] : []
    })
  )
  // Why: the handle ended is the one the re-check just read, never the plan's older one.
  const current = new Map<string, BackgroundRuntimeTerminal>()
  const keyOf = (row: SessionTidyRow): string | null => row.paneKey ?? row.tabId
  const owns = (row: SessionTidyRow): boolean => {
    const key = keyOf(row)
    return key !== null && plannedByKey.has(key)
  }
  return {
    owns,
    /** The verdict now: still a runtime-owned PTY with no window tab, and the same process. */
    recheck(row: SessionTidyRow): SessionTidyVerdict {
      const key = keyOf(row)!
      const plannedTerminal = plannedByKey.get(key)!
      const now = context.runtime
        .listBackgroundRuntimeOwnedTerminals()
        ?.find(
          (terminal) =>
            terminal.ptyId === plannedTerminal.ptyId && backgroundTidyKey(terminal) === key
        )
      if (!now) {
        current.delete(key)
        return { action: 'skip', reason: BACKGROUND_TIDY_GONE }
      }
      current.set(key, now)
      return classifyBackgroundTidy(now, options)
    },
    async end(
      row: SessionTidyRow,
      actor: SessionManageActor,
      provenance: SessionManageProvenance
    ): Promise<{ auditError?: string }> {
      const rechecked = current.get(keyOf(row)!)
      if (!rechecked) {
        throw new Error(BACKGROUND_TIDY_GONE)
      }
      const { terminal, closed } = await endBackgroundRuntimeTerminal(context, rechecked.ptyId)
      const auditError = await recordSessionAction({
        actor,
        action: 'session.delete',
        target: { paneKey: row.paneKey, tabId: row.tabId, title: row.title },
        summary: backgroundEndSummary(row.title),
        provenance,
        after: { ptyId: terminal.ptyId, ptyKilled: closed.ptyKilled, background: true }
      })
      return auditError ? { auditError } : {}
    }
  }
}
