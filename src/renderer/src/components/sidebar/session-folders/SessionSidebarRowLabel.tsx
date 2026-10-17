import { SessionRowTodoBadge } from '@/components/goals-todos/SessionRowTodoBadge'
import { useSessionDisplayTitle } from '@/components/goals-todos/use-session-display-title'
import { SessionTagChips } from './SessionTagChips'
import { SessionRowModelIcon } from './SessionRowModelIcon'
import { useSessionViewMode } from './session-view-mode-selector'
import type { ConversationState } from '@/lib/conversation-state'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { localWorkflowAgentLine } from '@/lib/local-workflow-tab-status'
import { ConversationRowTitle } from './ConversationRowTitle'
import { ConversationStateIcon } from './ConversationStateIcon'
import { SessionSidebarRowStatusLine } from './SessionSidebarRowStatusLine'
import { SessionSidebarRowWorkflowState } from './SessionSidebarRowWorkflowState'
import type { SessionRowStatus } from './session-row-status'
import { useSessionSearchPreview } from './session-search-preview-context'
import { SessionSearchPreviewLine } from './SessionSearchPreviewLine'
import { SessionRowWasTitle } from './SessionRowWasTitle'
import { SessionRowHostLabel } from './SessionRowHostLabel'
import { SessionRowRestLabel } from './SessionRowRestLabel'
import { useSessionRowRestLabel } from './use-session-row-host-label'
import { translate } from '@/i18n/i18n'

/**
 * The row's leading glyph. A workflow conversation shows its own state and preset icon, as the tab
 * strip does; every other row shows its conversation state on its surface.
 */
function RowGlyph({
  session,
  compact,
  surface,
  visualState,
  unreadCompletion
}: {
  session: SidebarSession
  compact: boolean
  surface: ReturnType<typeof useSessionViewMode>
  visualState: ConversationState
  unreadCompletion: boolean
}): React.JSX.Element {
  return session.workflow ? (
    <SessionSidebarRowWorkflowState workflow={session.workflow} compact={compact} />
  ) : (
    <ConversationStateIcon
      unreadCompletion={unreadCompletion}
      surface={surface}
      state={visualState}
      size={compact ? 'sm' : 'md'}
    />
  )
}

/**
 * What the row's open button holds. Compact: a 12 px state glyph and the name on one line —
 * the agent, the status and the activity wait in the hover card. Comfortable: the glyph, the
 * name, the agent (or technical detail) and one status or activity line. Either names the
 * computer after the name when the list mixes computers.
 */
export function SessionSidebarRowLabel({
  compact,
  session,
  subagent = false,
  visualState,
  unreadCompletion = false,
  agentLine,
  status,
  activityLine,
  activitySignal,
  hostLabel = null,
  onStartRename
}: {
  compact: boolean
  session: SidebarSession
  subagent?: boolean
  visualState: ConversationState
  unreadCompletion?: boolean
  agentLine: string | null | undefined
  status: SessionRowStatus | null
  activityLine: string | null
  activitySignal: string | null | undefined
  /** The computer it runs on, when the list mixes computers. */
  hostLabel?: string | null
  onStartRename?: () => void
}): React.JSX.Element {
  const surface = useSessionViewMode(session)
  const title = useSessionDisplayTitle(session)
  // Why one or the other: "paused on <computer>" already names the computer.
  const restLabel = useSessionRowRestLabel(session)
  const place = restLabel ? (
    <SessionRowRestLabel label={restLabel} />
  ) : hostLabel ? (
    <SessionRowHostLabel label={hostLabel} />
  ) : null
  // Why: a row found by what was said in it shows that passage, so the reason it is listed reads
  // without opening it.
  const searchPreview = useSessionSearchPreview(session.rowKey)
  // Why: a workflow's line is its preset and, while it runs, the phase the host reports.
  const line =
    session.workflow && agentLine === session.agent
      ? localWorkflowAgentLine(session.workflow)
      : agentLine
  const glyph = (
    <RowGlyph
      session={session}
      compact={compact}
      surface={surface}
      visualState={visualState}
      unreadCompletion={unreadCompletion}
    />
  )
  if (compact) {
    return (
      <>
        {glyph}
        <span className="min-w-0 flex-1" data-session-row-line="">
          <ConversationRowTitle
            title={title}
            onStartRename={onStartRename}
            trailing={
              <>
                {subagent ? (
                  <span
                    className="ml-1 shrink-0 text-[10px] font-medium tracking-wide text-muted-foreground"
                    data-session-subagent=""
                    title={translate('conversations.subagent', 'Subagent')}
                  >
                    {translate('conversations.subagentMarker', 'SUB')}
                  </span>
                ) : null}
                {place}
                <SessionRowModelIcon session={session} />
                {/* Why dots, not chips: a compact row is one line, and a labelled chip cannot
                    share it with the name without wrapping the row onto a second. */}
                <SessionTagChips session={session} variant="dots" />
                <SessionRowTodoBadge session={session} />
              </>
            }
          />
          {searchPreview ? <SessionSearchPreviewLine text={searchPreview} /> : null}
        </span>
      </>
    )
  }
  return (
    <>
      {glyph}
      <span className="min-w-0 flex-1">
        <ConversationRowTitle
          title={title}
          onStartRename={onStartRename}
          trailing={
            <>
              {subagent ? (
                <span
                  className="ml-1 shrink-0 text-[10px] font-medium tracking-wide text-muted-foreground"
                  data-session-subagent=""
                  title={translate('conversations.subagent', 'Subagent')}
                >
                  {translate('conversations.subagentMarker', 'SUB')}
                </span>
              ) : null}
              {place}
              <SessionRowModelIcon session={session} />
              <SessionRowTodoBadge session={session} />
            </>
          }
        />
        <SessionTagChips session={session} />
        <SessionRowWasTitle session={session} />
        <span
          className="block truncate text-xs font-normal text-muted-foreground"
          data-session-agent-line=""
        >
          {line}
        </span>
        {status ? (
          <SessionSidebarRowStatusLine status={status} />
        ) : activityLine ? (
          <span
            className="block truncate text-xs font-normal text-muted-foreground"
            data-session-activity-row={activitySignal}
            title={activityLine}
          >
            {activityLine}
          </span>
        ) : null}
        {searchPreview ? <SessionSearchPreviewLine text={searchPreview} /> : null}
      </span>
    </>
  )
}
