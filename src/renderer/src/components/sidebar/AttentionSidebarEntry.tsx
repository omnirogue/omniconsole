import React from 'react'
import { Focus } from 'lucide-react'
import { isCommandCenterView } from '@/lib/command-center-navigation'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { AgentQuestionIcon } from '@/components/AgentQuestionIcon'
import { useAgentPaneSnapshot } from '@/components/attention/use-agent-pane-snapshot'
import { translate } from '@/i18n/i18n'

/** Sidebar entry for the attention view; the badge counts panes waiting on the user. */
export default function AttentionSidebarEntry(): React.JSX.Element {
  const count = useAgentPaneSnapshot().attention.length
  const active = useAppStore((state) =>
    state.settings?.commandCenter
      ? isCommandCenterView(state.activeView)
      : state.activeView === 'attention'
  )
  const toggleAttentionPage = useAppStore((state) => state.toggleAttentionPage)
  return (
    <button
      type="button"
      onClick={toggleAttentionPage}
      aria-current={active ? 'page' : undefined}
      data-attention-count={count}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors',
        active
          ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
          : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
      )}
    >
      <Focus
        className={cn('size-4 shrink-0', !active && 'text-worktree-sidebar-foreground/30')}
        strokeWidth={active ? 2.25 : 1.75}
      />
      <span className="flex-1">
        {translate('auto.components.sidebar.SidebarNav.attention', 'Attention')}
      </span>
      {count > 0 ? (
        <span
          aria-label={translate(
            'auto.components.sidebar.SidebarNav.attentionCount',
            '{{count}} need you',
            { count }
          )}
          className="inline-flex items-center gap-1 rounded-full bg-agent-question/15 px-1.5 py-px text-[10px] font-semibold tabular-nums text-agent-question-text"
        >
          <AgentQuestionIcon className="size-2.5" />
          {count}
        </span>
      ) : null}
    </button>
  )
}
