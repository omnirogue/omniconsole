import type { AppState } from '@/store/types'
import { getIndexedWorktreesById } from '@/store/worktree-repo-index'
import { resolveBackofficeBaseUrl } from '../../../../../shared/backoffice-connection'
import { HUB_TASK_ID_PATTERN } from '../../../../../shared/omnios-task-binding'
import { isOfficeTaskProjection } from './office-task-projection'

type ProjectionNavigationState = Pick<
  AppState,
  'settings' | 'worktreesByRepo' | 'folderWorkspaces' | 'detectedWorktreesByRepo'
>

export function officeProjectionBackofficeUrl(
  taskId: string,
  state: ProjectionNavigationState
): string | null {
  const connection = resolveBackofficeBaseUrl(state.settings ?? {})
  if (!connection.configured || !isOfficeTaskProjection(taskId)) {
    return null
  }
  if (taskId.startsWith('sess:')) {
    return `${connection.baseUrl}/sessions/${encodeURIComponent(taskId.slice(5))}`
  }
  const workspaceId = taskId.slice('worktree:'.length)
  const linkedItems = [
    ...getIndexedWorktreesById(state.worktreesByRepo, workspaceId).map((row) => row.linkedWorkItem),
    ...Object.values(state.detectedWorktreesByRepo)
      .flatMap((result) => result.worktrees)
      .filter((row) => row.id === workspaceId)
      .map((row) => row.linkedWorkItem),
    ...state.folderWorkspaces.filter((row) => row.id === workspaceId).map((row) => row.linkedTask)
  ].filter((item) => item?.hubTaskId && HUB_TASK_ID_PATTERN.test(item.hubTaskId))
  const hubTaskIds = new Set(linkedItems.map((item) => item?.hubTaskId))
  if (hubTaskIds.size !== 1) {
    return connection.baseUrl
  }
  const item = linkedItems[0]
  if (item?.provider === 'backoffice' && item.url) {
    try {
      const source = new URL(item.url)
      if (
        source.origin === new URL(connection.baseUrl).origin &&
        !source.username &&
        !source.password
      ) {
        return source.href
      }
    } catch {
      // A malformed source link still has the existing canonical card navigation path.
    }
  }
  return `${connection.baseUrl}/work#work?task=${encodeURIComponent(item?.hubTaskId ?? '')}`
}
