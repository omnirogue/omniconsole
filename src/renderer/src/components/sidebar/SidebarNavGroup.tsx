import React, { useId, useState } from 'react'
import { useAppStore } from '@/store'
import { sidebarDragInFlight, clearSidebarDrag } from './sidebar-drag'
import { isSidebarMemberScope } from '../../../../shared/sidebar-navigation-placement'
import { ChevronRight } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { NavGroupDefinition } from './sidebar-nav-groups'
import {
  SIDEBAR_NAV_ROW_CLASS,
  sidebarNavIconClass,
  sidebarNavRowStateClass
} from './SidebarNavMemberButton'

export function SidebarNavGroup({
  group,
  icon: Icon,
  active,
  current,
  onOpen,
  badge,
  children
}: {
  group: NavGroupDefinition | { id: string; name: string; primaryView?: undefined }
  icon: LucideIcon
  /** The group owns the active view. */
  active: boolean
  /** The primary's own page is the active view, so it carries `aria-current`. */
  current: boolean
  onOpen?: () => void
  badge?: React.ReactNode
  children?: React.ReactNode
}): React.JSX.Element {
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null)
  const expanded = userExpanded ?? ('name' in group || (group.id === 'work' && active))
  const label = 'name' in group ? group.name : translate(group.labelKey, group.labelFallback)
  const membersId = useId()
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => {
              setUserExpanded(!expanded)
              if (group.primaryView) {
                onOpen?.()
              }
            }}
            onDragOver={(event) => {
              const source = sidebarDragInFlight()
              if (!source || !isSidebarMemberScope(source.scope)) {
                return
              }
              event.preventDefault()
              event.stopPropagation()
              event.dataTransfer.dropEffect = 'move'
              setUserExpanded(true)
            }}
            onDrop={(event) => {
              const source = sidebarDragInFlight()
              const destination = `nav:${group.id}`
              if (
                !source ||
                !isSidebarMemberScope(source.scope) ||
                !isSidebarMemberScope(destination)
              ) {
                return
              }
              event.preventDefault()
              event.stopPropagation()
              const state = useAppStore.getState()
              state.moveSidebarMember(
                source.id,
                destination,
                state.sidebarLayout.orders[destination] ?? []
              )
              clearSidebarDrag()
              setUserExpanded(true)
            }}
            aria-expanded={expanded}
            aria-controls={membersId}
            aria-current={current ? 'page' : undefined}
            data-nav-group={group.id}
            data-nav-group-active={active ? 'true' : undefined}
            className={cn(SIDEBAR_NAV_ROW_CLASS, sidebarNavRowStateClass(active))}
          >
            <Icon className={sidebarNavIconClass(active)} strokeWidth={active ? 2.25 : 1.75} />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {badge}
            <ChevronRight
              className={cn(
                'size-3.5 transition-transform motion-reduce:transition-none',
                expanded && 'rotate-90'
              )}
            />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={6}>
          {'name' in group ? group.name : translate(group.tooltipKey, group.tooltipFallback)}
        </TooltipContent>
      </Tooltip>
      {expanded && children ? (
        <div
          id={membersId}
          className="flex flex-col gap-0.5 pl-6"
          data-nav-group-members={group.id}
        >
          {children}
        </div>
      ) : null}
    </>
  )
}
