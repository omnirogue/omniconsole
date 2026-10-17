import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { WorkspaceLinkedItem } from '../../shared/worktree/types'

export const HUB_CARD_ID_PATTERN = /^btk_[A-Za-z0-9]{4,64}$/

export type LedgerLinkedCard = { cardId: string; cardTitle: string | null }

/** The two places the IDE persists an explicit work-item link: worktree meta and folder workspaces. */
export type LinkedCardSource = {
  getWorktreeMeta?(worktreeId: string): WorktreeMeta | undefined
  getFolderWorkspaces?(): FolderWorkspace[]
}

/**
 * The card a workspace was explicitly linked to (brief §7), or null. Only the persisted
 * `linkedWorkItem.hubTaskId` counts — never a branch name, a cwd, or a provider issue number.
 */
export function linkedCardForWorktree(
  source: LinkedCardSource,
  worktreeId: string
): LedgerLinkedCard | null {
  let item: WorkspaceLinkedItem | null | undefined
  try {
    item =
      source.getWorktreeMeta?.(worktreeId)?.linkedWorkItem ??
      source.getFolderWorkspaces?.().find((workspace) => workspace.id === worktreeId)?.linkedTask
  } catch {
    return null
  }
  const cardId = item?.hubTaskId?.trim()
  if (!cardId || !HUB_CARD_ID_PATTERN.test(cardId)) {
    return null
  }
  const title = typeof item?.title === 'string' ? item.title.trim().slice(0, 200) : ''
  return { cardId, cardTitle: title || null }
}
