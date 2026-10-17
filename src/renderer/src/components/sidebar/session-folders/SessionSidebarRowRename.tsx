import { useSessionViewMode } from './session-view-mode-selector'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { ConversationState } from '@/lib/conversation-state'
import { cn } from '@/lib/utils'
import { ConversationRenameField } from './ConversationRenameField'
import { ConversationStateIcon } from './ConversationStateIcon'
import { SessionSidebarRowWorkflowState } from './SessionSidebarRowWorkflowState'

/** The row while its name is being edited: the glyph, the field, and (comfortable) the agent line. */
export function SessionSidebarRowRename({
  compact,
  session,
  title,
  visualState,
  agentLine,
  onRename,
  onDone
}: {
  session: SidebarSession
  compact: boolean
  title: string
  visualState: ConversationState
  agentLine: string | null | undefined
  onRename: (title: string | null) => void
  onDone: (fromKeyboard: boolean) => void
}): React.JSX.Element {
  const surface = useSessionViewMode(session)
  return (
    <div
      className={cn(
        'flex min-w-0 flex-1 items-center px-2',
        compact ? 'gap-1.5 py-1' : 'gap-2 py-2'
      )}
      data-session-renaming=""
    >
      {session.workflow ? (
        <SessionSidebarRowWorkflowState workflow={session.workflow} compact={compact} />
      ) : (
        <ConversationStateIcon surface={surface} state={visualState} size={compact ? 'sm' : 'md'} />
      )}
      <span className="min-w-0 flex-1">
        <ConversationRenameField title={title} onRename={onRename} onDone={onDone} />
        {compact ? null : (
          <span className="block truncate text-xs text-muted-foreground">{agentLine}</span>
        )}
      </span>
    </div>
  )
}
