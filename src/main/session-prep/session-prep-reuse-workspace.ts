import { resolve } from 'node:path'
import { sessionManageHostKey } from '../../shared/session-manage-query'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { sessionOwnerLoad } from '../session-manage/session-manage-owner-load'
import { runtimeChainBound } from '../session-manage/session-manage-owner-runtime'
import { observeSessionManageRows } from '../session-manage/session-manage-inventory'
import { createRuntimeObserveSources } from '../session-manage/session-manage-runtime-sources'

/** Re-read the local workspace before offering it and again after the person's click. */
export async function assertSessionPrepReuseWorkspace(
  runtime: OrcaRuntimeService,
  rows: readonly SessionManageSidebarRow[],
  owner: { paneKey: string; cwd?: string },
  actualCwd?: string
): Promise<void> {
  const row = rows.find((entry) => entry.paneKey === owner.paneKey)
  const cwd = actualCwd ?? row?.worktreePath ?? owner.cwd
  if (!cwd || (row && sessionManageHostKey(row.hostId) !== 'local')) {
    throw new Error('The existing session’s local workspace could not be verified.')
  }
  const path = resolve(cwd)
  const sharing = rows.filter(
    (entry) =>
      entry.paneKey !== owner.paneKey &&
      sessionManageHostKey(entry.hostId) === 'local' &&
      entry.worktreePath &&
      resolve(entry.worktreePath) === path
  )
  for (const observed of await observeSessionManageRows(
    sharing,
    createRuntimeObserveSources(runtime)
  )) {
    if (observed.entry.verdict === 'exited') {
      continue
    }
    if (
      observed.entry.verdict !== 'live' ||
      !sessionOwnerLoad(observed.entry, runtimeChainBound(runtime, observed.row)).light
    ) {
      throw new Error(
        `The target folder is held by “${observed.entry.title}”; its work is not verified idle.`
      )
    }
  }
  const scan = await runtime.scanWorkspacePorts(actualCwd ? undefined : (row?.repoId ?? undefined))
  if (scan.unavailableReason) {
    throw new Error(`Serving-checkout check is unavailable: ${scan.unavailableReason}`)
  }
  if (scan.ports.some((port) => port.kind === 'workspace' && resolve(port.owner.path) === path)) {
    throw new Error('The target folder is serving a local listener; choose a different workspace.')
  }
}
