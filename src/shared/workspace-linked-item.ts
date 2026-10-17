import { BOARD_TASK_ID_PATTERN } from './board-task-id'
import type { WorkspaceLinkedItem } from './worktree/types'

export function areWorkspaceLinkedItemsEqual(
  a: WorkspaceLinkedItem | null | undefined,
  b: WorkspaceLinkedItem | null | undefined
): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b) {
    return !a && !b
  }
  return (
    a.provider === b.provider &&
    a.type === b.type &&
    a.number === b.number &&
    a.title === b.title &&
    a.url === b.url &&
    (a.linearIdentifier ?? null) === (b.linearIdentifier ?? null) &&
    (a.jiraIdentifier ?? null) === (b.jiraIdentifier ?? null) &&
    (a.repoId ?? null) === (b.repoId ?? null) &&
    (a.hubTaskId ?? null) === (b.hubTaskId ?? null) &&
    (a.hubStateRevision ?? null) === (b.hubStateRevision ?? null) &&
    (a.hubNextAction ?? null) === (b.hubNextAction ?? null)
  )
}

export function normalizeWorkspaceLinkedItem(value: unknown): WorkspaceLinkedItem | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const raw = value as Partial<WorkspaceLinkedItem>
  if (
    raw.provider !== 'github' &&
    raw.provider !== 'gitlab' &&
    raw.provider !== 'linear' &&
    raw.provider !== 'jira' &&
    raw.provider !== 'backoffice'
  ) {
    return null
  }
  if (raw.type !== 'issue' && raw.type !== 'pr' && raw.type !== 'mr') {
    return null
  }
  if (
    typeof raw.number !== 'number' ||
    !Number.isFinite(raw.number) ||
    typeof raw.title !== 'string' ||
    raw.title.trim().length === 0 ||
    typeof raw.url !== 'string' ||
    raw.url.trim().length === 0
  ) {
    return null
  }
  const hubTaskId = typeof raw.hubTaskId === 'string' ? raw.hubTaskId.trim() : ''
  const hasHubTask = BOARD_TASK_ID_PATTERN.test(hubTaskId)
  return {
    provider: raw.provider,
    type: raw.type,
    number: raw.number,
    title: raw.title.trim(),
    url: raw.url.trim(),
    ...(typeof raw.linearIdentifier === 'string' && raw.linearIdentifier.trim().length > 0
      ? { linearIdentifier: raw.linearIdentifier.trim() }
      : {}),
    ...(typeof raw.jiraIdentifier === 'string' && raw.jiraIdentifier.trim().length > 0
      ? { jiraIdentifier: raw.jiraIdentifier.trim() }
      : {}),
    ...(typeof raw.repoId === 'string' && raw.repoId.trim().length > 0
      ? { repoId: raw.repoId.trim() }
      : {}),
    ...(hasHubTask ? { hubTaskId } : {}),
    ...(hasHubTask &&
    typeof raw.hubStateRevision === 'number' &&
    Number.isSafeInteger(raw.hubStateRevision) &&
    raw.hubStateRevision >= 0
      ? { hubStateRevision: raw.hubStateRevision }
      : {}),
    ...(hasHubTask && typeof raw.hubNextAction === 'string' && raw.hubNextAction.trim()
      ? { hubNextAction: raw.hubNextAction.trim() }
      : {})
  }
}
