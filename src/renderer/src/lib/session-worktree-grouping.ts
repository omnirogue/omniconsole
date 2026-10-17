import type { WorkspaceLineage, WorktreeLineage } from '../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../shared/worktree/types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { isValidResolvedWorktreeLineageEdge } from '../../../shared/resolved-worktree-lineage'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import { getWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'

/**
 * Folder-first declutter: a workspace is its main checkout or a folder; every linked
 * worktree belongs to whatever made it. One grouping for the sidebar and the launcher
 * so the two lists can never disagree about where a worktree lives.
 */
export type SessionWorktreePlacement =
  | { kind: 'top-level' }
  /** Nested under a top-level worktree; `rootIdentity` is that top-level ancestor. */
  | { kind: 'nested'; parentIdentity: string; rootIdentity: string }
  /** `parentIdentity` is set when a session worktree in the same group is the parent. */
  | {
      kind: 'folder'
      folderWorkspaceId: string
      /** Host-qualified folder identity (see getFolderWorkspaceIdentity). */
      folderIdentity: string
      parentIdentity?: string
    }
  /** No known workspace: goes in the collapsed "Existing worktrees" group. */
  | { kind: 'existing'; parentIdentity?: string }

export type SessionWorktreeGrouping = {
  placementByIdentity: Map<string, SessionWorktreePlacement>
  /** Top-level worktrees plus their nested descendants, in input order. */
  mainList: Worktree[]
  /** Descendants of each top-level worktree, keyed by that ancestor's host identity. */
  nestedByRootIdentity: Map<string, Worktree[]>
  /** Keyed by host-qualified folder identity, so same-id folders on two hosts never merge. */
  byFolderIdentity: Map<string, Worktree[]>
  existing: Worktree[]
}

export type SessionWorktreeGroupingInput = {
  worktrees: readonly Worktree[]
  worktreeLineageById: Readonly<Record<string, WorktreeLineage>>
  workspaceLineageByChildKey: Readonly<Record<string, WorkspaceLineage>>
  /** Host-qualified identities of folders that exist; an edge to any other folder counts as unknown. */
  folderWorkspaceIdentities: ReadonlySet<string>
}

/** A linked worktree the user did not pin: the session-made kind the declutter folds away. */
/** A folder is unique only per host; an absent host is this computer. */
export function getFolderWorkspaceIdentity(
  hostId: ExecutionHostId | null | undefined,
  folderWorkspaceId: string
): string {
  return `${hostId ?? LOCAL_EXECUTION_HOST_ID}|${folderWorkspaceId}`
}

export function isSessionWorktree(
  worktree: Pick<Worktree, 'isMainWorktree' | 'isPinned'>
): boolean {
  return !worktree.isMainWorktree && !worktree.isPinned
}

function getWorktreeLineage(
  worktree: Worktree,
  lineageById: Readonly<Record<string, WorktreeLineage>>
): WorktreeLineage | null {
  // Why mirror appendWorktreeRows: the sidebar nests by this exact edge, and a
  // different choice here would fold a row under a parent it never renders beneath.
  const projected = Object.hasOwn(lineageById, worktree.id) ? lineageById[worktree.id] : null
  const inline = (worktree as Worktree & { lineage?: WorktreeLineage | null }).lineage ?? null
  return projected?.worktreeInstanceId === worktree.instanceId ? projected : inline
}

export function groupSessionWorktrees(
  input: SessionWorktreeGroupingInput
): SessionWorktreeGrouping {
  const { worktrees, worktreeLineageById, workspaceLineageByChildKey, folderWorkspaceIdentities } =
    input
  const byIdentity = new Map(worktrees.map((w) => [getWorktreeHostIdentity(w), w]))
  const placementByIdentity = new Map<string, SessionWorktreePlacement>()

  const directParentOf = (
    worktree: Worktree
  ):
    | { kind: 'worktree'; identity: string }
    | { kind: 'folder'; id: string; identity: string }
    | null => {
    const lineage = getWorktreeLineage(worktree, worktreeLineageById)
    if (lineage) {
      const parentIdentity = getWorktreeHostIdentity({
        id: lineage.parentWorktreeId,
        hostId: worktree.hostId
      })
      const parent = byIdentity.get(parentIdentity)
      if (parent && isValidResolvedWorktreeLineageEdge(worktree, parent, lineage)) {
        return { kind: 'worktree', identity: parentIdentity }
      }
    }
    const workspaceLineage = workspaceLineageByChildKey[worktreeWorkspaceKey(worktree.id)]
    // Why: this map is keyed by bare id, so only the exact instance it recorded may claim the edge;
    // a missing id on either side cannot prove it and leaves the row in Existing.
    if (
      !workspaceLineage?.childInstanceId ||
      !worktree.instanceId ||
      workspaceLineage.childInstanceId !== worktree.instanceId
    ) {
      return null
    }
    const parentScope = parseWorkspaceKey(workspaceLineage.parentWorkspaceKey)
    if (parentScope?.type !== 'folder') {
      return null
    }
    const folderIdentity = getFolderWorkspaceIdentity(
      worktree.hostId,
      parentScope.folderWorkspaceId
    )
    return folderWorkspaceIdentities.has(folderIdentity)
      ? { kind: 'folder', id: parentScope.folderWorkspaceId, identity: folderIdentity }
      : null
  }

  const place = (identity: string, visiting: Set<string>): SessionWorktreePlacement => {
    const cached = placementByIdentity.get(identity)
    if (cached) {
      return cached
    }
    const worktree = byIdentity.get(identity)!
    let placement: SessionWorktreePlacement
    if (!isSessionWorktree(worktree)) {
      placement = { kind: 'top-level' }
    } else {
      const parent = directParentOf(worktree)
      if (!parent || (parent.kind === 'worktree' && visiting.has(parent.identity))) {
        // Why: a cyclic lineage has no real owner; treating it as unknown keeps it reachable.
        placement = { kind: 'existing' }
      } else if (parent.kind === 'folder') {
        placement = {
          kind: 'folder',
          folderWorkspaceId: parent.id,
          folderIdentity: parent.identity
        }
      } else {
        visiting.add(identity)
        const parentPlacement = place(parent.identity, visiting)
        visiting.delete(identity)
        placement =
          parentPlacement.kind === 'top-level'
            ? { kind: 'nested', parentIdentity: parent.identity, rootIdentity: parent.identity }
            : parentPlacement.kind === 'nested'
              ? {
                  kind: 'nested',
                  parentIdentity: parent.identity,
                  rootIdentity: parentPlacement.rootIdentity
                }
              : { ...parentPlacement, parentIdentity: parent.identity }
      }
    }
    placementByIdentity.set(identity, placement)
    return placement
  }

  const mainList: Worktree[] = []
  const nestedByRootIdentity = new Map<string, Worktree[]>()
  const byFolderIdentity = new Map<string, Worktree[]>()
  const existing: Worktree[] = []
  for (const worktree of worktrees) {
    const identity = getWorktreeHostIdentity(worktree)
    const placement = place(identity, new Set([identity]))
    if (placement.kind === 'top-level') {
      mainList.push(worktree)
    } else if (placement.kind === 'nested') {
      mainList.push(worktree)
      const list = nestedByRootIdentity.get(placement.rootIdentity) ?? []
      list.push(worktree)
      nestedByRootIdentity.set(placement.rootIdentity, list)
    } else if (placement.kind === 'folder') {
      const list = byFolderIdentity.get(placement.folderIdentity) ?? []
      list.push(worktree)
      byFolderIdentity.set(placement.folderIdentity, list)
    } else {
      existing.push(worktree)
    }
  }
  return { placementByIdentity, mainList, nestedByRootIdentity, byFolderIdentity, existing }
}

/**
 * Identities that must stay on screen while their group is collapsed: the given ones
 * (attention, active, reveal targets) plus every ancestor, so a surfaced child is never
 * rendered without the row it hangs from.
 */
export function withSessionWorktreeAncestors(
  grouping: SessionWorktreeGrouping,
  identities: Iterable<string>
): Set<string> {
  const result = new Set<string>()
  for (const identity of identities) {
    let current: string | undefined = identity
    while (current && !result.has(current)) {
      result.add(current)
      const placement = grouping.placementByIdentity.get(current)
      current = placement && placement.kind !== 'top-level' ? placement.parentIdentity : undefined
    }
  }
  return result
}
