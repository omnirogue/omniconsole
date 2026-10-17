import { useState } from 'react'
import { ListFilter } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  SESSION_SIDEBAR_SORTS,
  sessionSidebarSort,
  type SessionSidebarSort
} from '@/lib/session-sidebar-sort'
import { useSessionAgentFilter } from '@/store/session-agent-filter'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { useSessionTags } from '@/store/session-tags'
import { SessionAgentFilterButtons } from './SessionAgentFilterButtons'
import { SessionTagFilterPanel } from './SessionTagPicker'

function sortLabel(sort: SessionSidebarSort): string {
  switch (sort) {
    case 'status':
      return translate('conversations.viewPicker.sortStatus', 'Status')
    case 'name':
      return translate('conversations.viewPicker.sortName', 'Name')
    case 'host':
      return translate('conversations.viewPicker.sortHost', 'Host')
    case 'manual':
      return translate('conversations.viewPicker.sortManual', 'Manual')
  }
}

/** How rows are ordered inside every group, saved on this device; not a filter, so never counted. */
function SessionSortControl(): React.JSX.Element {
  const sort = useSessionSidebarView((state) => sessionSidebarSort(state.view))
  const choose = (next: SessionSidebarSort): void => useSessionSidebarView.getState().setSort(next)
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">
        {translate('conversations.viewPicker.sort', 'Sort')}
      </p>
      <ToggleGroup
        type="single"
        value={sort}
        onValueChange={(value) => {
          if (value) {
            choose(value as SessionSidebarSort)
          }
        }}
        variant="outline"
        size="sm"
        className="h-6 w-full justify-stretch"
        aria-label={translate('conversations.viewPicker.sort', 'Sort')}
      >
        {SESSION_SIDEBAR_SORTS.map((option) => (
          <ToggleGroupItem
            key={option}
            value={option}
            className="h-6 grow basis-0 px-1 text-[10px] data-[state=on]:bg-foreground/10 data-[state=on]:font-semibold data-[state=on]:text-foreground"
          >
            {sortLabel(option)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )
}

/**
 * One "Filter" button opening the agent and tag filters together, so the crowded toolbar keeps
 * a single row of icons instead of six agent logos plus the tag picker.
 */
export function SessionFilterMenu(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const agentFilter = useSessionAgentFilter((state) => state.filter)
  const clearAgentFilter = useSessionAgentFilter((state) => state.clear)
  const tagFilter = useSessionTags((state) => state.data.filter)
  const setTagFilter = useSessionTags((state) => state.setFilter)
  const activeCount = (agentFilter ? 1 : 0) + tagFilter.length
  const active = activeCount > 0
  const label = translate('conversations.filterMenu', 'Filter conversations')
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant={active ? 'secondary' : 'ghost'}
              size="icon-xs"
              className={active ? 'relative' : 'relative text-muted-foreground'}
              aria-label={label}
              aria-pressed={active}
            >
              <ListFilter className="size-3.5" />
              {active ? (
                <span
                  aria-hidden="true"
                  className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full bg-primary text-[9px] leading-none text-primary-foreground"
                >
                  {activeCount}
                </span>
              ) : null}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-64 space-y-3 p-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">{label}</p>
          {active ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                clearAgentFilter()
                setTagFilter([])
              }}
            >
              {translate('sessionTags.clear', 'Clear filters')}
            </Button>
          ) : null}
        </div>
        <SessionSortControl />
        <div className="space-y-1.5 border-t pt-2">
          <p className="text-xs font-medium text-muted-foreground">
            {translate('conversations.filterMenuAgents', 'Agents')}
          </p>
          <SessionAgentFilterButtons />
        </div>
        <div className="space-y-1.5 border-t pt-2">
          <p className="text-xs font-medium text-muted-foreground">
            {translate('conversations.filterMenuTags', 'Tags')}
          </p>
          <SessionTagFilterPanel
            onManageTags={() => {
              setOpen(false)
              useAppStore.getState().openSettingsTarget({
                pane: 'session-tags',
                repoId: null,
                sectionId: 'session-tags'
              })
              useAppStore.getState().openSettingsPage()
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}
