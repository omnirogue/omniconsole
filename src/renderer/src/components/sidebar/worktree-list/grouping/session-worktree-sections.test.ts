import { describe, expect, it } from 'vitest'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { repo, repoMap, worktree as baseWorktree } from '../../worktree-list-groups-test-fixtures'
import { buildSessionWorktreeLayout } from '../listing/use-session-worktree-layout'
import { buildRows } from './build-rows'
import { getSessionLineageOpenKey } from './group-keys'
import type { Row } from './row-types'
import {
  EXISTING_WORKTREES_GROUP_KEY,
  appendSessionWorktreeSections,
  withDefaultCollapsedKeys
} from './session-worktree-sections'

function wt(name: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    ...baseWorktree,
    id: `${repo.id}::/tmp/${name}`,
    instanceId: `${name}-instance`,
    path: `/tmp/${name}`,
    branch: `refs/heads/${name}`,
    displayName: name,
    ...overrides
  }
}

const main = wt('main', { isMainWorktree: true })
const child = wt('child')
const orphan = wt('orphan')
const attention = wt('attention')
const lineageById: Record<string, WorktreeLineage> = {
  [child.id]: {
    worktreeId: child.id,
    worktreeInstanceId: child.instanceId!,
    parentWorktreeId: main.id,
    parentWorktreeInstanceId: main.instanceId!,
    origin: 'cli',
    capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
    createdAt: 1
  }
}

function render(storedCollapsed: Set<string>, surfaced: string[] = []): Row[] {
  const worktrees = [main, child, orphan, attention]
  const worktreeMap = new Map(worktrees.map((w) => [w.id, w]))
  const layout = buildSessionWorktreeLayout({
    visibleWorktrees: worktrees,
    worktreeLineageById: lineageById,
    workspaceLineageByChildKey: {},
    folderWorkspaces: [],
    surfacedWorktreeIds: surfaced
  })
  const collapsed = withDefaultCollapsedKeys(storedCollapsed, layout.defaultCollapsedKeys)
  const rows = buildRows(
    'repo',
    layout.grouping.mainList,
    repoMap,
    null,
    collapsed,
    undefined,
    undefined,
    'manual',
    lineageById,
    worktreeMap,
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
    undefined,
    undefined,
    layout.sessionView
  )
  appendSessionWorktreeSections(rows, {
    grouping: layout.grouping,
    folderWorkspaces: [],
    collapsedGroups: collapsed,
    sessionView: layout.sessionView,
    repoMap,
    lineageById,
    worktreeMap,
    cyclicLineageIds: new Set(),
    defaultHostId: 'local'
  })
  return rows
}

const itemNames = (rows: Row[]): string[] =>
  rows.flatMap((row) => (row.type === 'item' ? [row.worktree.displayName] : []))

describe('session worktree sections', () => {
  it('shows only the main checkout by default, with children and orphans folded away', () => {
    const rows = render(new Set())
    expect(itemNames(rows)).toEqual(['main'])
    const mainRow = rows.find((row) => row.type === 'item' && row.worktree.id === main.id)
    expect(mainRow).toMatchObject({ lineageChildCount: 1, lineageCollapsed: true })
    const existingHeader = rows.find(
      (row) => row.type === 'header' && row.key === EXISTING_WORKTREES_GROUP_KEY
    )
    expect(existingHeader).toMatchObject({ label: 'Existing worktrees · 2', count: 2 })
  })

  it('keeps an attention worktree visible inside a collapsed group', () => {
    expect(itemNames(render(new Set(), [attention.id]))).toEqual(['main', 'attention'])
    expect(itemNames(render(new Set(), [child.id]))).toEqual(['main', 'child'])
  })

  it('opens a fold when its key is stored, since these groups default to collapsed', () => {
    const opened = new Set([
      EXISTING_WORKTREES_GROUP_KEY,
      getSessionLineageOpenKey({ id: main.id, hostId: main.hostId })
    ])
    expect(itemNames(render(opened))).toEqual(['main', 'child', 'orphan', 'attention'])
  })

  it('leaves the classic list untouched when no session view is passed', () => {
    const worktrees = [main, child, orphan]
    const rows = buildRows(
      'repo',
      worktrees,
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      'manual',
      lineageById,
      new Map(worktrees.map((w) => [w.id, w])),
      true
    )
    expect(itemNames(rows)).toEqual(['main', 'child', 'orphan'])
    expect(getWorktreeHostIdentity(child)).toBeTruthy()
  })
})
