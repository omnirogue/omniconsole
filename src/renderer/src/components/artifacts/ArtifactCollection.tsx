import { useCallback, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { ArtifactListItem } from '../../../../shared/artifacts'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { clampArtifactListSearchQuery, filterArtifactsBySearchQuery } from './artifact-list-search'
import { groupArtifactsBySession, type ArtifactSessionGroup } from './artifact-list-filter'
import { artifactName } from './artifact-display-labels'
import { artifactWhoLabel } from './artifact-lifecycle-labels'
import {
  artifactHeaderSelectionState,
  toggleAllArtifactSelection,
  toggleArtifactSelection
} from './artifact-selection'
import { ArtifactListRows, type ArtifactRowsLifecycle } from './ArtifactListRows'
import { ArtifactListTableHeader } from './ArtifactListTableHeader'
import { ArtifactListToolbar, type ArtifactToolbarLifecycle } from './ArtifactListToolbar'
import { LIST_TABLE_CONTAINER_CLASS } from '@/lib/list-table-layout'

export type ArtifactCollectionLifecycle = ArtifactToolbarLifecycle &
  Pick<ArtifactRowsLifecycle, 'handlers' | 'checkedSlugs' | 'sessionLinks' | 'openSuccessor'> & {
    onCheckedChange: (next: Set<string>) => void
  }

export function ArtifactCollection({
  artifacts,
  deletingId,
  selectedSlug,
  selectArtifact,
  deleteArtifact,
  hasMore,
  loadingMore,
  loadMore,
  onRefresh,
  isRefreshing,
  lifecycle
}: {
  artifacts: readonly ArtifactListItem[]
  deletingId: string | null
  selectedSlug: string | null
  selectArtifact: (slug: string) => void
  deleteArtifact: (item: ArtifactListItem) => void
  hasMore: boolean
  loadingMore: boolean
  loadMore: () => void
  onRefresh: () => void
  isRefreshing: boolean
  /** Present once the server has shown lifecycle fields. */
  lifecycle?: ArtifactCollectionLifecycle
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  // Why: clamp on the way in so a multi-MB paste never reaches state or filtering.
  const onQueryChange = (next: string): void => setQuery(clampArtifactListSearchQuery(next))
  const matches = useMemo(() => filterArtifactsBySearchQuery(artifacts, query), [artifacts, query])
  const sessionLinks = lifecycle?.sessionLinks
  const groups = useMemo<ArtifactSessionGroup[] | null>(
    () =>
      lifecycle?.groupBySession && sessionLinks
        ? groupArtifactsBySession(
            matches,
            (item) => artifactWhoLabel(item, sessionLinks.get(item.artifact.slug)?.title ?? null),
            translate('auto.components.artifacts.lifecycle.noSession', 'No session')
          )
        : null,
    [lifecycle?.groupBySession, matches, sessionLinks]
  )
  const visibleSlugs = useMemo(
    () =>
      (groups ? groups.flatMap((group) => group.items) : matches).map((item) => item.artifact.slug),
    [groups, matches]
  )
  const titles = useMemo(
    () => new Map(artifacts.map((item) => [item.artifact.slug, artifactName(item)])),
    [artifacts]
  )
  const anchor = useRef<string | null>(null)
  const checkedSlugs = lifecycle?.checkedSlugs
  const onCheckedChange = lifecycle?.onCheckedChange
  const toggleChecked = useCallback(
    (slug: string, shift: boolean): void => {
      if (!checkedSlugs || !onCheckedChange) {
        return
      }
      onCheckedChange(
        toggleArtifactSelection(checkedSlugs, slug, {
          shift,
          anchor: anchor.current,
          order: visibleSlugs
        })
      )
      anchor.current = slug
    },
    [checkedSlugs, onCheckedChange, visibleSlugs]
  )
  const rowsLifecycle: ArtifactRowsLifecycle | undefined = lifecycle
    ? {
        handlers: lifecycle.handlers,
        checkedSlugs: lifecycle.checkedSlugs,
        toggleChecked,
        sessionLinks: lifecycle.sessionLinks,
        titleForSlug: (slug) => titles.get(slug) ?? null,
        openSuccessor: lifecycle.openSuccessor
      }
    : undefined
  const rowProps = {
    deletingId,
    selectedSlug,
    selectArtifact,
    deleteArtifact,
    lifecycle: rowsLifecycle
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 pb-4 md:px-5">
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <ArtifactListToolbar
          query={query}
          onQueryChange={onQueryChange}
          onRefresh={onRefresh}
          isRefreshing={isRefreshing}
          lifecycle={lifecycle}
        />
        <div
          className={cn('scrollbar-sleek min-h-0 flex-1 overflow-auto', LIST_TABLE_CONTAINER_CLASS)}
        >
          <ArtifactListTableHeader
            selection={
              lifecycle
                ? {
                    state: artifactHeaderSelectionState(lifecycle.checkedSlugs, visibleSlugs),
                    onToggleAll: () =>
                      lifecycle.onCheckedChange(
                        toggleAllArtifactSelection(lifecycle.checkedSlugs, visibleSlugs)
                      )
                  }
                : undefined
            }
          />
          {matches.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {artifacts.length === 0
                ? translate(
                    'auto.components.artifacts.ArtifactCollection.emptyView',
                    'No pages in this view'
                  )
                : translate('auto.components.artifacts.ArtifactCollection.noMatches', 'No matches')}
            </p>
          ) : groups ? (
            groups.map((group) => (
              <div key={group.key} role="group" aria-label={group.label}>
                <div className="border-b border-border/50 bg-muted/25 px-3 py-1.5 text-[11px] font-semibold text-muted-foreground">
                  {group.label}
                </div>
                <div className="divide-y divide-border/50">
                  <ArtifactListRows artifacts={group.items} {...rowProps} />
                </div>
              </div>
            ))
          ) : (
            <div className="divide-y divide-border/50">
              <ArtifactListRows artifacts={matches} {...rowProps} />
            </div>
          )}
          {hasMore ? (
            <div className="border-t border-border/50 p-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full"
                disabled={loadingMore}
                onClick={loadMore}
              >
                {loadingMore ? <Loader2 className="animate-spin" /> : null}
                {translate('auto.components.artifacts.ArtifactCollection.loadMore', 'Load more')}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}
