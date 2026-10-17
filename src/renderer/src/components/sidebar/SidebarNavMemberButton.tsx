import React from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { HideSidebarMenu } from './sidebar-nav-controls'

export const SIDEBAR_NAV_ROW_CLASS =
  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors'

export function sidebarNavRowStateClass(active: boolean): string {
  return active
    ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
    : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
}

export function sidebarNavIconClass(active: boolean): string {
  return cn('size-4 shrink-0', !active && 'text-worktree-sidebar-foreground/30')
}

/** One navigation row; wrapped in a hide-from-sidebar context menu when the entry has a setting. */
export function SidebarNavMemberButton({
  icon: Icon,
  label,
  active,
  onClick,
  onHide,
  badge
}: {
  icon: LucideIcon
  label: string
  active: boolean
  onClick: () => void
  onHide?: () => void
  badge?: React.ReactNode
}): React.JSX.Element {
  const button = (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(SIDEBAR_NAV_ROW_CLASS, sidebarNavRowStateClass(active))}
    >
      <Icon className={sidebarNavIconClass(active)} strokeWidth={active ? 2.25 : 1.75} />
      <span className="flex-1">{label}</span>
      {badge}
    </button>
  )
  if (!onHide) {
    return button
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{button}</ContextMenuTrigger>
      <HideSidebarMenu onHide={onHide} />
    </ContextMenu>
  )
}
