import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type {
  WorkspaceLineage,
  WorktreeLineage
} from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { cloneDefaultWorkspaceStatuses } from '../../../../../../shared/workspace-statuses'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { groupSessionWorktrees } from '@/lib/session-worktree-grouping'
import { repoMap, worktree as base } from '../../worktree-list-groups-test-fixtures'
import { buildSessionWorktreeLayout } from '../listing/use-session-worktree-layout'
import {
  expandGroupsForWorktreeReveal,
  type PendingSidebarRevealArgs
} from '../navigation/pending-reveal-inputs'
import { getBulkCollapsedGroupKeys } from '../../sidebar-collapsible-groups'
import { buildRows } from './build-rows'
import { collectCollapsibleSidebarGroupKeys } from './collapsible-group-keys'
import { SESSION_LINEAGE_OPEN_PREFIX } from './group-keys'
import type { WorktreeGroupBy } from './row-types'
import {
  EXISTING_WORKTREES_GROUP_KEY,
  appendSessionWorktreeSections,
  withDefaultCollapsedKeys
} from './session-worktree-sections'

const statuses = cloneDefaultWorkspaceStatuses()
const wt = (id: string, extra: Partial<Worktree> = {}): Worktree => ({
  ...base,
  id,
  path: `/tmp/${id}`,
  instanceId: `${id}-instance`,
  displayName: id,
  ...extra
})
const edge = (child: Worktree, parent: Worktree): WorktreeLineage => ({
  worktreeId: child.id,
  worktreeInstanceId: child.instanceId!,
  parentWorktreeId: parent.id,
  parentWorktreeInstanceId: parent.instanceId!,
  origin: 'cli',
  capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
  createdAt: 1
})
const folder = {
  id: 'ops',
  projectGroupId: 'pg',
  name: 'Ops',
  folderPath: '/tmp/ops',
  executionHostId: 'local',
  isArchived: false,
  isPinned: false,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
  lastActivityAt: 0
} as FolderWorkspace
const folderEdge = (child: Worktree): WorkspaceLineage => ({
  childWorkspaceKey: `worktree:${child.id}`,
  childInstanceId: child.instanceId,
  parentWorkspaceKey: 'folder:ops',
  origin: 'cli',
  capture: { source: 'env-workspace', confidence: 'explicit' },
  createdAt: 1
})

function render(
  worktrees: Worktree[],
  opts: {
    lineage?: Record<string, WorktreeLineage>
    workspaceLineage?: Record<string, WorkspaceLineage>
    folders?: FolderWorkspace[]
    surfaced?: string[]
    stored?: Set<string>
    groupBy?: WorktreeGroupBy
  } = {}
) {
  const lineage = opts.lineage ?? {}
  const layout = buildSessionWorktreeLayout({
    visibleWorktrees: worktrees,
    worktreeLineageById: lineage,
    workspaceLineageByChildKey: opts.workspaceLineage ?? {},
    folderWorkspaces: opts.folders ?? [],
    surfacedWorktreeIds: opts.surfaced ?? []
  })
  const collapsed = withDefaultCollapsedKeys(opts.stored ?? new Set(), layout.defaultCollapsedKeys)
  const map = new Map(worktrees.map((w) => [w.id, w]))
  const rows = buildRows(
    opts.groupBy ?? 'repo',
    layout.grouping.mainList,
    repoMap,
    null,
    collapsed,
    undefined,
    statuses,
    'manual',
    lineage,
    map,
    true,
    undefined,
    [],
    undefined,
    undefined,
    undefined,
    [],
    undefined,
    [],
    undefined,
    'local',
    undefined,
    layout.sessionView
  )
  appendSessionWorktreeSections(rows, {
    grouping: layout.grouping,
    folderWorkspaces: opts.folders ?? [],
    collapsedGroups: collapsed,
    sessionView: layout.sessionView,
    repoMap,
    lineageById: lineage,
    worktreeMap: map,
    cyclicLineageIds: new Set(),
    defaultHostId: 'local'
  })
  return {
    rows,
    layout,
    collapsed,
    ids: rows.flatMap((row) => (row.type === 'item' ? [row.worktree.id] : []))
  }
}

function reveal(
  worktrees: Worktree[],
  lineage: Record<string, WorktreeLineage>,
  stored: Set<string>,
  rendered: ReturnType<typeof render>,
  target: Worktree,
  groupBy: WorktreeGroupBy = 'repo'
): void {
  expandGroupsForWorktreeReveal(
    {
      worktrees,
      worktreeLineageById: lineage,
      worktreeMap: new Map(worktrees.map((w) => [w.id, w])),
      folderWorkspaces: [],
      repoMap,
      collapsedGroups: rendered.collapsed,
      groupBy,
      pinnedDisplayPolicy: 'single-location',
      defaultHostId: 'local',
      prCache: null,
      workspaceStatuses: statuses,
      projectGroups: [],
      sessionLayout: rendered.layout,
      toggleGroup: (key: string) => {
        if (stored.has(key)) {
          stored.delete(key)
        } else {
          stored.add(key)
        }
      }
    } as unknown as PendingSidebarRevealArgs,
    target.id,
    target.hostId
  )
}

describe('session worktree review regressions (PR #894 codex review)', () => {
  it('F1: reveal opens the lane of the top-level owner a nested child renders in', () => {
    const main = wt('main', { isMainWorktree: true, workspaceStatus: 'in-progress' })
    const child = wt('child', { workspaceStatus: 'in-review' })
    const trees = [main, child]
    const lineage = { child: edge(child, main) }
    const stored = new Set(['workspace-status:in-progress'])
    const before = render(trees, {
      lineage,
      surfaced: ['child'],
      stored,
      groupBy: 'workspace-status'
    })
    reveal(trees, lineage, stored, before, child, 'workspace-status')
    expect(render(trees, { lineage, stored, groupBy: 'workspace-status' }).ids).toContain('child')
  })

  it('F2: a completed reveal leaves its target visible after the pending request clears', () => {
    const main = wt('main', { isMainWorktree: true })
    const child = wt('child')
    const orphan = wt('orphan')
    const trees = [main, child, orphan]
    const lineage = { child: edge(child, main) }
    const stored = new Set<string>()
    reveal(trees, lineage, stored, render(trees, { lineage, surfaced: ['child'], stored }), child)
    reveal(trees, lineage, stored, render(trees, { lineage, surfaced: ['orphan'], stored }), orphan)
    const after = render(trees, { lineage, stored }).ids
    expect(after).toContain('child')
    expect(after).toContain('orphan')
  })

  it('F3: a surfaced grandchild keeps its ancestors in Existing and folder groups, open or closed', () => {
    const parent = wt('parent')
    const child = wt('child')
    const grandchild = wt('grandchild')
    const trees = [parent, child, grandchild]
    const lineage = { child: edge(child, parent), grandchild: edge(grandchild, child) }
    const expected = ['parent', 'child', 'grandchild']
    expect(render(trees, { lineage, surfaced: ['grandchild'] }).ids).toEqual(expected)
    expect(
      render(trees, {
        lineage,
        surfaced: ['grandchild'],
        workspaceLineage: { 'worktree:parent': folderEdge(parent) },
        folders: [folder]
      }).ids
    ).toEqual(expected)
    expect(
      render(trees, {
        lineage,
        surfaced: ['grandchild'],
        stored: new Set([EXISTING_WORKTREES_GROUP_KEY])
      }).ids
    ).toEqual(expected)
  })

  it('F4: a folder edge keyed by bare id adopts only the matching instance on the matching host', () => {
    const local = wt('same', { hostId: 'local', instanceId: 'local-instance' })
    const remote = wt('same', { hostId: 'ssh:box' as never, instanceId: 'remote-instance' })
    const grouping = groupSessionWorktrees({
      worktrees: [local, remote],
      worktreeLineageById: {},
      workspaceLineageByChildKey: { 'worktree:same': folderEdge(local) },
      folderWorkspaceIdentities: new Set(['local|ops'])
    })
    expect(grouping.placementByIdentity.get(getWorktreeHostIdentity(local))?.kind).toBe('folder')
    expect(grouping.placementByIdentity.get(getWorktreeHostIdentity(remote))?.kind).toBe('existing')
  })

  it('N2: a row with no instance id cannot claim a folder edge recorded for another instance', () => {
    const legacy = wt('legacy', { instanceId: undefined })
    const grouping = groupSessionWorktrees({
      worktrees: [legacy],
      worktreeLineageById: {},
      workspaceLineageByChildKey: {
        'worktree:legacy': { ...folderEdge(legacy), childInstanceId: 'old-instance' }
      },
      folderWorkspaceIdentities: new Set(['local|ops'])
    })
    expect(grouping.placementByIdentity.get(getWorktreeHostIdentity(legacy))?.kind).toBe('existing')
  })

  it('N4: a same-id folder on another host never decides a local worktree’s placement', () => {
    const child = wt('child')
    const remoteFolder = { ...folder, executionHostId: 'ssh:box' } as FolderWorkspace
    for (const folders of [
      [folder, remoteFolder],
      [remoteFolder, folder]
    ]) {
      const rendered = render([child], {
        workspaceLineage: { 'worktree:child': folderEdge(child) },
        folders
      })
      expect(
        rendered.layout.grouping.placementByIdentity.get(getWorktreeHostIdentity(child))
      ).toMatchObject({
        kind: 'folder',
        folderIdentity: 'local|ops'
      })
    }
  })

  it('N3: collapse all then expand all reopens nested session worktrees', () => {
    const main = wt('main', { isMainWorktree: true })
    const child = wt('child')
    const lineage = { child: edge(child, main) }
    const stored = new Set([`${SESSION_LINEAGE_OPEN_PREFIX}${getWorktreeHostIdentity(main)}`])
    const before = render([main, child], { lineage, stored })
    expect(before.ids).toEqual(['main', 'child'])
    const bulk = (collapse: boolean, current: Set<string>) =>
      new Set(
        getBulkCollapsedGroupKeys({
          collapse,
          collapsibleGroupKeys: collectCollapsibleSidebarGroupKeys(before.rows),
          defaultCollapsedKeys: before.layout.defaultCollapsedKeys,
          storedCollapsedGroups: current,
          isOpenPolarityKey: (key) => key.startsWith(SESSION_LINEAGE_OPEN_PREFIX)
        })
      )
    const reopened = bulk(false, bulk(true, stored))
    expect(render([main, child], { lineage, stored: reopened }).ids).toEqual(['main', 'child'])
  })

  it('F6: collapse all then expand all opens session groups instead of closing them', () => {
    const main = wt('main', { isMainWorktree: true })
    const orphan = wt('orphan')
    const stored = new Set(['repo:repo-1', EXISTING_WORKTREES_GROUP_KEY])
    const before = render([main, orphan], { stored })
    const bulk = (collapse: boolean, current: Set<string>) =>
      new Set(
        getBulkCollapsedGroupKeys({
          collapse,
          collapsibleGroupKeys: collectCollapsibleSidebarGroupKeys(before.rows),
          defaultCollapsedKeys: before.layout.defaultCollapsedKeys,
          storedCollapsedGroups: current,
          isOpenPolarityKey: (key) => key.startsWith(SESSION_LINEAGE_OPEN_PREFIX)
        })
      )
    const collapsedAll = bulk(true, stored)
    expect(render([main, orphan], { stored: collapsedAll }).ids).not.toContain('orphan')
    expect(render([main, orphan], { stored: bulk(false, collapsedAll) }).ids).toContain('orphan')
  })
})
