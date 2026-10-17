import type { ArtifactListItem, ArtifactListState } from '../../../../shared/artifacts'
import { translate } from '@/i18n/i18n'

export const ARTIFACT_LIST_FILTERS = ['needs_me', 'open', 'closed', 'all'] as const
export type ArtifactListFilter = (typeof ARTIFACT_LIST_FILTERS)[number]
export const DEFAULT_ARTIFACT_LIST_FILTER: ArtifactListFilter = 'open'

/** `state` for `artifacts.list`; All sends none, which a server reads as every live page. */
export function artifactListStateForFilter(
  filter: ArtifactListFilter
): ArtifactListState | undefined {
  return filter === 'all' ? undefined : filter
}

export function isArtifactListFilter(value: string): value is ArtifactListFilter {
  return (ARTIFACT_LIST_FILTERS as readonly string[]).includes(value)
}

export function artifactListFilterLabel(filter: ArtifactListFilter): string {
  switch (filter) {
    case 'needs_me':
      return translate('auto.components.artifacts.filter.needsMe', 'Needs me')
    case 'open':
      return translate('auto.components.artifacts.filter.open', 'Open')
    case 'closed':
      return translate('auto.components.artifacts.filter.closed', 'Closed')
    case 'all':
      return translate('auto.components.artifacts.filter.all', 'All')
  }
}

export type ArtifactSessionGroup = {
  key: string
  label: string
  items: readonly ArtifactListItem[]
}

/** Rows grouped by `sessionRef`, newest group first; rows without a session last. */
export function groupArtifactsBySession(
  items: readonly ArtifactListItem[],
  sessionLabel: (item: ArtifactListItem) => string,
  noSessionLabel: string
): ArtifactSessionGroup[] {
  const groups = new Map<string, { label: string; items: ArtifactListItem[]; newest: number }>()
  const ungrouped: ArtifactListItem[] = []
  for (const item of items) {
    const ref = item.sessionRef
    if (!ref) {
      ungrouped.push(item)
      continue
    }
    const updated = Date.parse(item.artifact.updatedAt)
    const time = Number.isNaN(updated) ? 0 : updated
    const group = groups.get(ref)
    if (group) {
      group.items.push(item)
      group.newest = Math.max(group.newest, time)
    } else {
      groups.set(ref, { label: sessionLabel(item), items: [item], newest: time })
    }
  }
  const ordered = [...groups.entries()]
    .sort(([, left], [, right]) => right.newest - left.newest)
    .map(([key, group]) => ({ key, label: group.label, items: group.items }))
  return ungrouped.length > 0
    ? [...ordered, { key: '', label: noSessionLabel, items: ungrouped }]
    : ordered
}
