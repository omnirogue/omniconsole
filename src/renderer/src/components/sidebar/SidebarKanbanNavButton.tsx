import { Columns3 } from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

/** One click from the sidebar to the personal Kanban, instead of three levels into Tasks. */
export function SidebarKanbanNavButton(): React.JSX.Element {
  const active = useAppStore((state) => state.activeView === 'kanban')
  const openKanbanPage = useAppStore((state) => state.openKanbanPage)
  return (
    <button
      type="button"
      onClick={openKanbanPage}
      aria-current={active ? 'page' : undefined}
      data-sidebar-nav="work:kanban"
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors',
        active
          ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
          : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
      )}
    >
      <Columns3
        className={cn('size-4 shrink-0', !active && 'text-worktree-sidebar-foreground/30')}
        strokeWidth={active ? 2.25 : 1.75}
      />
      <span className="flex-1">{translate('nav.kanban', 'Kanban')}</span>
    </button>
  )
}
