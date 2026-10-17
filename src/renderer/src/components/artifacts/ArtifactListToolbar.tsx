import { Layers, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Toggle } from '@/components/ui/toggle'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  ARTIFACT_LIST_FILTERS,
  artifactListFilterLabel,
  isArtifactListFilter,
  type ArtifactListFilter
} from './artifact-list-filter'
import { ArtifactListSearchField } from './ArtifactListSearchField'

export type ArtifactToolbarLifecycle = {
  filter: ArtifactListFilter
  onFilterChange: (filter: ArtifactListFilter) => void
  groupBySession: boolean
  onGroupBySessionChange: (grouped: boolean) => void
}

export function ArtifactListToolbar({
  query,
  onQueryChange,
  onRefresh,
  isRefreshing,
  lifecycle
}: {
  query: string
  onQueryChange: (query: string) => void
  onRefresh: () => void
  isRefreshing: boolean
  /** Absent on an older server: no filter segment, no grouping. */
  lifecycle?: ArtifactToolbarLifecycle
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      <ArtifactListSearchField
        query={query}
        className="w-56"
        onQueryChange={onQueryChange}
        onClear={() => onQueryChange('')}
      />
      {lifecycle ? (
        <>
          <ToggleGroup
            type="single"
            variant="outline"
            value={lifecycle.filter}
            onValueChange={(value) => {
              if (isArtifactListFilter(value)) {
                lifecycle.onFilterChange(value)
              }
            }}
            aria-label={translate('auto.components.artifacts.filter.label', 'Show pages')}
          >
            {ARTIFACT_LIST_FILTERS.map((filter) => (
              <ToggleGroupItem key={filter} value={filter} className="h-8 px-3 text-xs">
                {artifactListFilterLabel(filter)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Toggle
            variant="outline"
            size="sm"
            pressed={lifecycle.groupBySession}
            onPressedChange={lifecycle.onGroupBySessionChange}
            className="h-8 gap-1.5 px-2.5 text-xs"
          >
            <Layers className="size-3.5" />
            {translate('auto.components.artifacts.filter.groupBySession', 'Group by session')}
          </Toggle>
        </>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={translate('auto.components.artifacts.ArtifactsPage.refresh', 'Refresh')}
            onClick={onRefresh}
            disabled={isRefreshing}
            className="shrink-0 border border-border bg-background shadow-none hover:bg-muted/50"
          >
            <RefreshCw className={cn('size-4', isRefreshing && 'animate-spin')} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {translate('auto.components.artifacts.ArtifactsPage.refresh', 'Refresh')}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
