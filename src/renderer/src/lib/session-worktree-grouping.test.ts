import { describe, expect, it } from 'vitest'
import type { WorkspaceLineage, WorktreeLineage } from '../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import {
  groupSessionWorktrees,
  isSessionWorktree,
  withSessionWorktreeAncestors
} from './session-worktree-grouping'

function wt(id: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: `repo-1::/tmp/${id}`,
    instanceId: `${id}-instance`,
    repoId: 'repo-1',
    path: `/tmp/${id}`,
    branch: `refs/heads/${id}`,
    head: 'abc',
    isBare: false,
    isMainWorktree: false,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    comment: '',
    isUnread: false,
    isPinned: false,
    displayName: id,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function lineage(child: Worktree, parent: Worktree): WorktreeLineage {
  return {
    worktreeId: child.id,
    worktreeInstanceId: child.instanceId!,
    parentWorktreeId: parent.id,
    parentWorktreeInstanceId: parent.instanceId!,
    origin: 'cli',
    capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
    createdAt: 1
  }
}

const main = wt('main', { isMainWorktree: true, branch: 'refs/heads/main' })

describe('isSessionWorktree', () => {
  it('treats unpinned linked worktrees as session worktrees', () => {
    expect(isSessionWorktree(wt('a'))).toBe(true)
    expect(isSessionWorktree(main)).toBe(false)
    expect(isSessionWorktree(wt('pinned', { isPinned: true }))).toBe(false)
  })
})

describe('groupSessionWorktrees', () => {
  it('nests lineage children under their top-level parent and sends orphans to Existing', () => {
    const child = wt('child')
    const grandchild = wt('grandchild')
    const orphan = wt('orphan')
    const grouping = groupSessionWorktrees({
      worktrees: [main, child, grandchild, orphan],
      worktreeLineageById: {
        [child.id]: lineage(child, main),
        [grandchild.id]: lineage(grandchild, child)
      },
      workspaceLineageByChildKey: {},
      folderWorkspaceIdentities: new Set<string>()
    })
    expect(grouping.mainList.map((w) => w.path)).toEqual([
      '/tmp/main',
      '/tmp/child',
      '/tmp/grandchild'
    ])
    expect(grouping.existing.map((w) => w.path)).toEqual(['/tmp/orphan'])
    expect(grouping.nestedByRootIdentity.get(getWorktreeHostIdentity(main))?.length).toBe(2)
    expect(grouping.placementByIdentity.get(getWorktreeHostIdentity(grandchild))).toEqual({
      kind: 'nested',
      parentIdentity: getWorktreeHostIdentity(child),
      rootIdentity: getWorktreeHostIdentity(main)
    })
  })

  it('places worktrees a folder workspace made under that folder, and descendants with them', () => {
    const fromFolder = wt('from-folder')
    const descendant = wt('descendant')
    const workspaceLineage: WorkspaceLineage = {
      childWorkspaceKey: `worktree:${fromFolder.id}`,
      childInstanceId: fromFolder.instanceId,
      parentWorkspaceKey: 'folder:ops',
      origin: 'cli',
      capture: { source: 'env-workspace', confidence: 'explicit' },
      createdAt: 1
    }
    const grouping = groupSessionWorktrees({
      worktrees: [fromFolder, descendant],
      worktreeLineageById: { [descendant.id]: lineage(descendant, fromFolder) },
      workspaceLineageByChildKey: { [workspaceLineage.childWorkspaceKey]: workspaceLineage },
      folderWorkspaceIdentities: new Set(['local|ops'])
    })
    expect(grouping.byFolderIdentity.get('local|ops')?.map((w) => w.path)).toEqual([
      '/tmp/from-folder',
      '/tmp/descendant'
    ])
    expect(grouping.mainList).toEqual([])
  })

  it('treats a lineage edge to an unknown folder or a stale instance as no parent', () => {
    const stale = wt('stale')
    const toGoneFolder = wt('gone-folder')
    const grouping = groupSessionWorktrees({
      worktrees: [main, stale, toGoneFolder],
      worktreeLineageById: {
        [stale.id]: { ...lineage(stale, main), worktreeInstanceId: 'recycled-path' }
      },
      workspaceLineageByChildKey: {
        [`worktree:${toGoneFolder.id}`]: {
          childWorkspaceKey: `worktree:${toGoneFolder.id}`,
          parentWorkspaceKey: 'folder:deleted',
          origin: 'cli',
          capture: { source: 'env-workspace', confidence: 'explicit' },
          createdAt: 1
        }
      },
      folderWorkspaceIdentities: new Set<string>()
    })
    expect(grouping.existing.map((w) => w.path)).toEqual(['/tmp/stale', '/tmp/gone-folder'])
  })

  it('keeps a lineage cycle reachable in Existing instead of recursing', () => {
    const a = wt('a')
    const b = wt('b')
    const grouping = groupSessionWorktrees({
      worktrees: [a, b],
      worktreeLineageById: { [a.id]: lineage(a, b), [b.id]: lineage(b, a) },
      workspaceLineageByChildKey: {},
      folderWorkspaceIdentities: new Set<string>()
    })
    expect(grouping.existing).toHaveLength(2)
  })

  it('keys by host so the same worktree id on two hosts is placed independently', () => {
    const localMain = { ...main, hostId: 'local' as const }
    const remoteChild = wt('child', { hostId: 'ssh:box' as never })
    const grouping = groupSessionWorktrees({
      worktrees: [localMain, remoteChild],
      worktreeLineageById: { [remoteChild.id]: lineage(remoteChild, main) },
      workspaceLineageByChildKey: {},
      folderWorkspaceIdentities: new Set<string>()
    })
    // Why: the lineage parent lives on another host, so it must not adopt this child.
    expect(grouping.existing).toEqual([remoteChild])
  })
})

describe('withSessionWorktreeAncestors', () => {
  it('adds every ancestor of a surfaced child so it never renders detached', () => {
    const child = wt('child')
    const grandchild = wt('grandchild')
    const grouping = groupSessionWorktrees({
      worktrees: [main, child, grandchild],
      worktreeLineageById: {
        [child.id]: lineage(child, main),
        [grandchild.id]: lineage(grandchild, child)
      },
      workspaceLineageByChildKey: {},
      folderWorkspaceIdentities: new Set<string>()
    })
    expect(withSessionWorktreeAncestors(grouping, [getWorktreeHostIdentity(grandchild)])).toEqual(
      new Set([grandchild, child, main].map((worktree) => getWorktreeHostIdentity(worktree)))
    )
  })
})
