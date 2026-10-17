/**
 * A pane the hibernation timer put to sleep before this app restarted has no terminal record, so
 * it reads `unverifiable`; the review wake restarts such a pane in place from its own sleep
 * checkpoint, and the claimer does the same for its owner's pane. The window refuses any pane
 * that is not its own slept one, so nothing that may still run is started twice.
 */

import { normalizeLaunchCause } from '../../shared/launch-cause'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionManageEntry } from '../../shared/session-manage-types'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { runtimeControlDeps } from '../session-manage/session-manage-runtime-actions'

type ParkedRuntime = Parameters<typeof runtimeControlDeps>[0] &
  Pick<OrcaRuntimeService, 'getTerminalHandleForPaneKey'>

export function isParkedPane(
  runtime: Pick<OrcaRuntimeService, 'getTerminalHandleForPaneKey'>,
  row: SessionManageSidebarRow,
  entry: Pick<SessionManageEntry, 'verdict'>
): boolean {
  return (
    entry.verdict === 'unverifiable' &&
    row.resumable &&
    !!row.paneKey &&
    runtime.getTerminalHandleForPaneKey(row.paneKey) === null
  )
}

export function restartParkedPane(
  runtime: ParkedRuntime,
  row: SessionManageSidebarRow
): Promise<{ summary: string }> {
  return runtimeControlDeps(runtime).resume(
    {
      ...(row.paneKey ? { paneKey: row.paneKey } : {}),
      ...(row.tabId ? { tabId: row.tabId } : {}),
      onlySleptPane: true
    },
    normalizeLaunchCause({ trigger: 'hibernation-wake', actor: { kind: 'app' } })
  )
}
