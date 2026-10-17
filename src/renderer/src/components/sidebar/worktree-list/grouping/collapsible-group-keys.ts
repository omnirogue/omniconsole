import type { HostSectionRow } from '../../host-section-rows'
import { PINNED_GROUP_KEY } from './group-keys'
import { getWorkspaceStatusGroupKey } from '../../../../../../shared/workspace-statuses'

const WORKSPACE_STATUS_GROUP_PREFIX = getWorkspaceStatusGroupKey('' as never)

/** Group headers the user can fold: repo/project headers, status lanes and the pinned section. */
export function collectCollapsibleSidebarGroupKeys(rows: readonly HostSectionRow[]): string[] {
  const keys: string[] = []
  for (const row of rows) {
    if (row.type !== 'header' || row.count === 0) {
      continue
    }
    if (
      row.repo !== undefined ||
      row.projectGroup !== undefined ||
      row.key === PINNED_GROUP_KEY ||
      row.key.startsWith(WORKSPACE_STATUS_GROUP_PREFIX)
    ) {
      keys.push(row.key)
    }
  }
  return keys
}
