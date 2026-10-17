import { CalendarDays } from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

export function SidebarCalendarNavButton(): React.JSX.Element {
  const active = useAppStore((state) => state.activeView === 'calendar')
  const openCalendarPage = useAppStore((state) => state.openCalendarPage)
  return (
    <button
      type="button"
      onClick={openCalendarPage}
      aria-current={active ? 'page' : undefined}
      data-sidebar-nav="work:calendar"
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors',
        active
          ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
          : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
      )}
    >
      <CalendarDays
        className={cn('size-4 shrink-0', !active && 'text-worktree-sidebar-foreground/30')}
      />
      <span className="flex-1">{translate('nav.calendar', 'Calendar')}</span>
    </button>
  )
}
