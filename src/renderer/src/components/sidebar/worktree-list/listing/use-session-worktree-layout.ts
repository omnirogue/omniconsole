import { useEffect, useMemo } from 'react'
import { useAppStore } from '@/store'
import { publishSidebarDefaultCollapsedGroupKeys } from '../../sidebar-collapsible-groups'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type {
  WorkspaceLineage,
  WorktreeLineage
} from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import {
  getFolderWorkspaceIdentity,
  groupSessionWorktrees,
  withSessionWorktreeAncestors,
  type SessionWorktreeGrouping
} from '@/lib/session-worktree-grouping'
import type { SessionWorktreeRowView } from '../grouping/row-types'
import {
  EXISTING_WORKTREES_GROUP_KEY,
  getFolderSessionWorktreesGroupKey,
  getSessionWorktreeSectionKeys
} from '../grouping/session-worktree-sections'
import { SESSION_LINEAGE_OPEN_PREFIX } from '../grouping/group-keys'

export type SessionWorktreeLayout = {
  grouping: SessionWorktreeGrouping
  sessionView: SessionWorktreeRowView
  /** Group headers that start collapsed. */
  defaultCollapsedKeys: string[]
}

type SessionWorktreeLayoutInput = {
  visibleWorktrees: readonly Worktree[]
  worktreeLineageById: Record<string, WorktreeLineage>
  workspaceLineageByChildKey: Record<string, WorkspaceLineage>
  folderWorkspaces: readonly FolderWorkspace[]
  /** Worktree ids that must stay on screen inside a collapsed group. */
  surfacedWorktreeIds: readonly (string | null | undefined)[]
}

export function buildSessionWorktreeLayout(
  input: SessionWorktreeLayoutInput
): SessionWorktreeLayout {
  const { visibleWorktrees } = input
  const grouping = groupSessionWorktrees({
    worktrees: visibleWorktrees,
    worktreeLineageById: input.worktreeLineageById,
    workspaceLineageByChildKey: input.workspaceLineageByChildKey,
    folderWorkspaceIdentities: new Set(
      input.folderWorkspaces.map((workspace) =>
        getFolderWorkspaceIdentity(workspace.executionHostId, workspace.id)
      )
    )
  })
  const surfacedIds = new Set(input.surfacedWorktreeIds.filter(Boolean))
  const surfacedIdentities = withSessionWorktreeAncestors(
    grouping,
    visibleWorktrees
      .filter((worktree) => surfacedIds.has(worktree.id))
      .map((worktree) => getWorktreeHostIdentity(worktree))
  )
  const byIdentity = new Map(visibleWorktrees.map((w) => [getWorktreeHostIdentity(w), w]))
  const laneOwnerByIdentity = new Map<string, Worktree>()
  for (const [identity, placement] of grouping.placementByIdentity) {
    const owner = placement.kind === 'nested' ? byIdentity.get(placement.rootIdentity) : undefined
    if (owner) {
      laneOwnerByIdentity.set(identity, owner)
    }
  }
  return {
    grouping,
    sessionView: { surfacedIdentities, laneOwnerByIdentity },
    defaultCollapsedKeys: getSessionWorktreeSectionKeys(grouping)
  }
}

/** The sidebar's folder-first declutter; null when the user turned it off (show all worktrees). */
export function useSessionWorktreeLayout(
  args: SessionWorktreeLayoutInput & { enabled: boolean }
): SessionWorktreeLayout | null {
  const {
    enabled,
    visibleWorktrees,
    worktreeLineageById,
    workspaceLineageByChildKey,
    folderWorkspaces,
    surfacedWorktreeIds
  } = args
  // Why a joined key: callers pass a fresh array each render; memo on its content.
  const surfacedKey = surfacedWorktreeIds.filter(Boolean).join('\n')
  return useMemo(
    () =>
      enabled
        ? buildSessionWorktreeLayout({
            visibleWorktrees,
            worktreeLineageById,
            workspaceLineageByChildKey,
            folderWorkspaces,
            surfacedWorktreeIds: surfacedKey.split('\n')
          })
        : null,
    [
      enabled,
      visibleWorktrees,
      worktreeLineageById,
      workspaceLineageByChildKey,
      folderWorkspaces,
      surfacedKey
    ]
  )
}

/**
 * The mounted sidebar's layout: reads the preference, surfaces the full attention set (the
 * closed-sidebar Cmd+1–9 order reads the same one) and publishes the default-collapsed keys.
 */
export function useSidebarSessionWorktreeLayout(
  args: Omit<SessionWorktreeLayoutInput, 'surfacedWorktreeIds'> & {
    attentionWorktreeIds: ReadonlySet<string>
    surfacedWorktreeIds: readonly (string | null | undefined)[]
  }
): SessionWorktreeLayout | null {
  const enabled = useAppStore((s) => s.groupSessionWorktrees)
  const { attentionWorktreeIds, ...input } = args
  const layout = useSessionWorktreeLayout({
    ...input,
    enabled,
    surfacedWorktreeIds: [...attentionWorktreeIds, ...args.surfacedWorktreeIds]
  })
  useEffect(() => {
    publishSidebarDefaultCollapsedGroupKeys(layout?.defaultCollapsedKeys ?? [])
  }, [layout])
  useEffect(() => () => publishSidebarDefaultCollapsedGroupKeys([]), [])
  return layout
}

/**
 * What a reveal must open so this worktree renders: its folded section's header, the lineage
 * fold of every ancestor, and the lane of the top-level worktree it renders under.
 */
export function getSessionWorktreeRevealTargets(
  layout: SessionWorktreeLayout,
  worktree: Pick<Worktree, 'id' | 'hostId'>
): { sectionKey: string | null; lineageOpenKeys: string[]; laneOwner: Worktree | undefined } {
  const identity = getWorktreeHostIdentity(worktree)
  const placement = layout.grouping.placementByIdentity.get(identity)
  const sectionKey =
    placement?.kind === 'existing'
      ? EXISTING_WORKTREES_GROUP_KEY
      : placement?.kind === 'folder'
        ? getFolderSessionWorktreesGroupKey(placement.folderIdentity)
        : null
  const lineageOpenKeys: string[] = []
  const seen = new Set([identity])
  let current = placement
  while (current && current.kind !== 'top-level' && current.parentIdentity) {
    const parentIdentity = current.parentIdentity
    if (seen.has(parentIdentity)) {
      break
    }
    seen.add(parentIdentity)
    lineageOpenKeys.push(`${SESSION_LINEAGE_OPEN_PREFIX}${parentIdentity}`)
    current = layout.grouping.placementByIdentity.get(parentIdentity)
  }
  return {
    sectionKey,
    lineageOpenKeys,
    laneOwner: layout.sessionView.laneOwnerByIdentity.get(identity)
  }
}
