import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { ProjectGroup } from '../../../../shared/project-group-types'

export function findHandoffFolderGroup(
  groups: readonly ProjectGroup[],
  path: string
): ProjectGroup | undefined {
  return groups.find(
    (group) =>
      !group.connectionId &&
      (!group.executionHostId || group.executionHostId === LOCAL_EXECUTION_HOST_ID) &&
      !!group.parentPath &&
      normalizeRuntimePathForComparison(group.parentPath) ===
        normalizeRuntimePathForComparison(path)
  )
}

export function handoffFolderGroupName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .at(-1) || path
  )
}
