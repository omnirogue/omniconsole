import { ChevronsUpDown } from 'lucide-react'
import { translate } from '@/i18n/i18n'

/** Lists every row of a group folded down to the conversation in use (see session-group-focus). */
export function SessionGroupShowAll(props: {
  count: number
  onShowAll: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-session-group-show-all=""
      onClick={props.onShowAll}
      className="flex h-6 w-full items-center gap-1.5 rounded-md px-2 text-left text-[11px] text-muted-foreground outline-none hover:bg-worktree-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-worktree-sidebar-ring"
    >
      <ChevronsUpDown className="size-3 shrink-0" aria-hidden />
      {translate('conversations.showAllInGroup', 'Show all {{count}}', { count: props.count })}
    </button>
  )
}
