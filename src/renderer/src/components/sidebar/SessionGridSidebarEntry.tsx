import React, { useEffect } from 'react'
import { LayoutGrid } from 'lucide-react'
import { isSessionGridView } from '@/lib/command-center-navigation'
import { useAppStore } from '@/store'
import { useSessionGrid } from '@/store/session-grid'
import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import { openSessionGrid } from '@/lib/session-grid-open'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

/** Sidebar entry for the Grid view; the count is how many panes it holds. */
export default function SessionGridSidebarEntry(): React.JSX.Element {
  const load = useSessionGrid((state) => state.load)
  const commandCenter = useAppStore((state) => state.settings?.commandCenter === true)
  const accountScope = useHandoffScope()
  const count = useSessionGrid((state) =>
    state.layout.tracks.reduce((sum, track) => sum + track.length, 0)
  )
  const active = useAppStore((state) =>
    isSessionGridView(state.activeView, state.settings?.commandCenter)
  )
  useEffect(() => {
    load(commandCenter)
  }, [load, commandCenter, accountScope])
  return (
    <button
      type="button"
      onClick={() =>
        active ? useAppStore.getState().setActiveView('terminal') : openSessionGrid()
      }
      aria-current={active ? 'page' : undefined}
      data-session-grid-count={count}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors',
        active
          ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
          : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
      )}
    >
      <LayoutGrid
        className={cn('size-4 shrink-0', !active && 'text-worktree-sidebar-foreground/30')}
        strokeWidth={active ? 2.25 : 1.75}
      />
      <span className="flex-1">{translate('nav.grid', 'Grid')}</span>
      {count > 0 ? (
        <span className="rounded-full bg-worktree-sidebar-foreground/10 px-1.5 py-px text-[10px] font-semibold tabular-nums">
          {count}
        </span>
      ) : null}
    </button>
  )
}
