import { FolderGit2, History } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import {
  getFolderWorkspaceIdentity,
  type SessionWorktreeGrouping
} from '@/lib/session-worktree-grouping'
import { getLaneHostWorktreeCounts, getLaneHostWorktreeIds } from './host-labels'
import { appendWorktreeRows } from './row-builders'
import type { Row, SessionWorktreeRowView } from './row-types'

export const EXISTING_WORKTREES_GROUP_KEY = 'session-worktrees:existing'

export function getFolderSessionWorktreesGroupKey(folderIdentity: string): string {
  return `session-worktrees:folder:${folderIdentity}`
}

/** Header keys of the folded session-worktree groups; they start collapsed, unlike other headers. */
export function getSessionWorktreeSectionKeys(grouping: SessionWorktreeGrouping): string[] {
  const keys = [...grouping.byFolderIdentity.keys()].map(getFolderSessionWorktreesGroupKey)
  if (grouping.existing.length > 0) {
    keys.push(EXISTING_WORKTREES_GROUP_KEY)
  }
  return keys
}

/** Flip default-collapsed keys: stored membership means "opened" for them, "closed" for the rest. */
export function withDefaultCollapsedKeys(
  collapsedGroups: Set<string>,
  defaultCollapsedKeys: readonly string[]
): Set<string> {
  if (defaultCollapsedKeys.length === 0) {
    return collapsedGroups
  }
  const next = new Set(collapsedGroups)
  for (const key of defaultCollapsedKeys) {
    if (next.has(key)) {
      next.delete(key)
    } else {
      next.add(key)
    }
  }
  return next
}

/**
 * Appends the folded groups below the regular sections: one per folder workspace that
 * made worktrees, then "Existing worktrees" for those with no known parent. A collapsed
 * group still lists the rows that need the user.
 */
export function appendSessionWorktreeSections(
  result: Row[],
  args: {
    grouping: SessionWorktreeGrouping
    folderWorkspaces: readonly FolderWorkspace[]
    collapsedGroups: Set<string>
    sessionView: SessionWorktreeRowView
    repoMap: Map<string, Repo>
    lineageById: Record<string, WorktreeLineage>
    worktreeMap: Map<string, Worktree>
    cyclicLineageIds: ReadonlySet<string>
    defaultHostId: ExecutionHostId
  }
): void {
  const { grouping, collapsedGroups, sessionView } = args
  const appendGroup = (
    key: string,
    label: string,
    icon: typeof History,
    worktrees: readonly Worktree[]
  ): void => {
    result.push({
      type: 'header',
      key,
      label,
      count: worktrees.length,
      tone: 'text-muted-foreground',
      icon,
      hostWorktreeCounts: getLaneHostWorktreeCounts(
        worktrees,
        [],
        args.repoMap,
        args.defaultHostId
      ),
      hostWorktreeIds: getLaneHostWorktreeIds(worktrees, [], args.repoMap, args.defaultHostId),
      worktreeIds: worktrees.map((worktree) => worktree.id)
    })
    const shown = collapsedGroups.has(key)
      ? worktrees.filter((worktree) =>
          sessionView.surfacedIdentities.has(getWorktreeHostIdentity(worktree))
        )
      : worktrees
    appendWorktreeRows(result, [...shown], args.repoMap, args.lineageById, args.worktreeMap, {
      nestLineage: true,
      collapsedGroups,
      groupDepth: 0,
      sectionKey: key,
      cyclicLineageIds: args.cyclicLineageIds,
      sessionView
    })
  }

  for (const folderWorkspace of args.folderWorkspaces) {
    const folderIdentity = getFolderWorkspaceIdentity(
      folderWorkspace.executionHostId,
      folderWorkspace.id
    )
    const worktrees = grouping.byFolderIdentity.get(folderIdentity)
    if (worktrees && worktrees.length > 0) {
      appendGroup(
        getFolderSessionWorktreesGroupKey(folderIdentity),
        translate('sidebar.sessionWorktrees.folderGroup', '{{name}} · {{count}} worktrees', {
          name: folderWorkspace.name,
          count: worktrees.length
        }),
        FolderGit2,
        worktrees
      )
    }
  }
  if (grouping.existing.length > 0) {
    appendGroup(
      EXISTING_WORKTREES_GROUP_KEY,
      translate('sidebar.sessionWorktrees.existing', 'Existing worktrees · {{count}}', {
        count: grouping.existing.length
      }),
      History,
      grouping.existing
    )
  }
}
