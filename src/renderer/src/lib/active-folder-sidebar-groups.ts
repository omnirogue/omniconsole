import type { SessionSidebarGroup, SessionSidebarTreeRow } from './session-sidebar-group-model'
import { rowNeedsPerson } from './session-sidebar-tree-order'

/**
 * Nests the Conversations folders the way Saved Sessions nests its own: a subfolder sits under
 * its parent, a folded folder folds everything below it, and a heading counts what is nested.
 */
export function nestActiveFolderGroups(folderGroups: ReadonlyMap<string, SessionSidebarGroup>): {
  roots: SessionSidebarGroup[]
  subtreeRows: (group: SessionSidebarGroup) => SessionSidebarTreeRow[]
  /** What shows below a top-level folder, in tree order; skips anything a query or hiding drops. */
  visibleDescendants: (
    group: SessionSidebarGroup,
    options: { query: boolean; showHidden: boolean }
  ) => SessionSidebarGroup[]
  nested: SessionSidebarGroup[]
} {
  const children = new Map<string, SessionSidebarGroup[]>()
  const roots: SessionSidebarGroup[] = []
  const nested: SessionSidebarGroup[] = []
  for (const group of folderGroups.values()) {
    const parentId = group.folder?.parentId
    if (parentId && folderGroups.has(parentId)) {
      children.set(parentId, [...(children.get(parentId) ?? []), group])
      nested.push(group)
    } else {
      roots.push(group)
    }
  }
  const cache = new Map<SessionSidebarGroup, SessionSidebarTreeRow[]>()
  const subtreeRows = (group: SessionSidebarGroup): SessionSidebarTreeRow[] => {
    const cached = cache.get(group)
    if (cached) {
      return cached
    }
    // Why: seed first so a looped parent link (already cut by withValidParents) cannot recurse forever.
    cache.set(group, group.rows)
    const rows = [
      ...group.rows,
      ...(children.get(group.folder?.id ?? '') ?? []).flatMap((child) => subtreeRows(child))
    ]
    cache.set(group, rows)
    return rows
  }
  const unhiddenNestedRows = (
    group: SessionSidebarGroup,
    seen = new Set([group])
  ): SessionSidebarTreeRow[] =>
    (children.get(group.folder?.id ?? '') ?? [])
      // Why the seen set: a looped parent link must not recurse forever.
      .filter((child) => !child.hidden && !seen.has(child) && seen.add(child))
      .flatMap((child) => [...child.rows, ...unhiddenNestedRows(child, seen)])
  for (const group of folderGroups.values()) {
    const all = subtreeRows(group)
    group.nestedRows = unhiddenNestedRows(group)
    group.childRowCount = all.length - group.rows.length
    group.attentionCount = all.filter(rowNeedsPerson).length
    if (group.collapsed && group.attentionCount > 0) {
      group.peekRows = all.filter(rowNeedsPerson)
    }
  }
  const visibleDescendants: ReturnType<typeof nestActiveFolderGroups>['visibleDescendants'] = (
    group,
    options
  ) => {
    if (group.collapsed) {
      return []
    }
    return (children.get(group.folder?.id ?? '') ?? []).flatMap((child) => {
      if (
        (options.query && subtreeRows(child).length === 0) ||
        (child.hidden && !options.showHidden)
      ) {
        return []
      }
      return [child, ...visibleDescendants(child, options)]
    })
  }
  return { roots, subtreeRows, visibleDescendants, nested }
}
