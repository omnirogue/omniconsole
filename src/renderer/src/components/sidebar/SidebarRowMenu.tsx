import { ArrowRight, EyeOff, MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { EMPTY_SIDEBAR_LAYOUT } from '../../../../shared/sidebar-layout'
import { isSidebarMemberScope } from '../../../../shared/sidebar-navigation-placement'

export function SidebarRowMenu({
  id,
  label,
  scope
}: {
  id: string
  label: string
  scope: string
}): React.JSX.Element {
  const layout = useAppStore((state) => state.sidebarLayout ?? EMPTY_SIDEBAR_LAYOUT)
  const move = useAppStore((state) => state.moveSidebarMember)
  const hide = useAppStore((state) => state.hideSidebarRow)
  const groups = [
    { scope: 'nav:work', name: translate('nav.work', 'Work') },
    { scope: 'nav:agents', name: translate('nav.agents', 'Agents') },
    ...(layout.groups ?? []).map((group) => ({ scope: `nav:${group.id}`, name: group.name }))
  ]
  const menuLabel = translate('sidebar.rowMenu', 'Options for {{label}}', { label })
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label={menuLabel} data-sidebar-row-menu="">
              <MoreHorizontal className="size-3.5" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{menuLabel}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {isSidebarMemberScope(scope) ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <ArrowRight className="size-4" aria-hidden />
              {translate('sidebar.moveTo', 'Move to')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {groups.map((group) => (
                <DropdownMenuItem
                  key={group.scope}
                  disabled={scope === group.scope}
                  onSelect={() => move(id, group.scope, layout.orders[group.scope] ?? [])}
                >
                  {group.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => hide(id, label)}>
          <EyeOff className="size-4" aria-hidden />
          {translate('sidebar.removeShortcut', 'Remove from sidebar')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
