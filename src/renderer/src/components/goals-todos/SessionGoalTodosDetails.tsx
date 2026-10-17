import { useMemo, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SessionDetailsFact, SessionDetailsSection } from '@/components/next-action/SessionDetails'
import { SessionActivityTodoList } from '@/components/session-activity/SessionActivityTodoList'
import { translate } from '@/i18n/i18n'
import type { SessionOutputs } from '@/components/next-action/use-session-outputs'
import { sessionAskOutputs } from '@/lib/session-ask-outputs'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { agentTodoProgress } from '../../../../shared/agent-todo-list'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { sessionAsks } from '../../../../shared/session-asks'
import type { SessionGoal } from '../../../../shared/session-goal'
import type { SessionGoalGroup } from '../../../../shared/session-goal-groups'
import { GoalsTodosProgressLine } from './GoalsTodosProgressLine'
import { SessionAsksList } from './SessionAsksList'
import { SessionGoalProgress } from './SessionProgress'
import { approveSessionGoal } from './use-session-goal-groups'
import type { SessionGoalTodosView } from './session-goal-todos-view'
import { useSessionGoalTodos } from './use-session-goal-todos'

/** One line of the goal; "more" opens the whole first prompt when the line cut it short. */
function GoalRow({
  goal,
  reading
}: {
  goal: SessionGoal | null
  reading: boolean
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  const label = translate('goalsTodos.goalLabel', 'Goal')
  if (!goal) {
    // Why nothing once read: an empty "Not found yet" row is noise, not information.
    return reading ? (
      <SessionDetailsFact id="goal" label={label}>
        <span className="text-muted-foreground">{translate('goalsTodos.reading', 'Reading…')}</span>
      </SessionDetailsFact>
    ) : null
  }
  const cut = goal.full.replace(/\s+/g, ' ').trim() !== goal.line
  return (
    <SessionDetailsFact id="goal" label={label}>
      {expanded ? null : (
        <span className="min-w-0 flex-1 truncate" title={goal.full} data-session-goal-line="">
          {goal.line}
        </span>
      )}
      {cut ? (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto shrink-0 px-1 text-xs text-muted-foreground"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? translate('goalsTodos.showLess', 'less')
            : translate('goalsTodos.showMore', 'more')}
        </Button>
      ) : null}
      {expanded ? (
        <p
          className="max-h-32 basis-full overflow-y-auto whitespace-pre-wrap break-words scrollbar-sleek"
          data-session-goal-full=""
        >
          {goal.full}
        </p>
      ) : null}
    </SessionDetailsFact>
  )
}

/**
 * "3 of 7 done" with its bar, then the checklist, which folds away to the current step. Under
 * milestones it starts folded: the AI's own steps are detail, not the headline.
 */
function TodoBody({
  view,
  folded = false
}: {
  view: SessionGoalTodosView
  folded?: boolean
}): React.JSX.Element {
  const [listOpen, setListOpen] = useState(!folded)
  if (view.todos.length === 0) {
    return (
      <p className="text-muted-foreground italic" data-session-todos-empty="">
        {translate('goalsTodos.reading', 'Reading…')}
      </p>
    )
  }
  return (
    <div className="min-w-0">
      {view.source === 'text' ? (
        <p className="text-muted-foreground" data-session-todos-source="text">
          {translate('goalsTodos.fromWrittenPlan', "(from the AI's written plan)")}
        </p>
      ) : null}
      <GoalsTodosProgressLine
        progress={agentTodoProgress(view.todos)}
        showStep={!listOpen}
        trailing={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="shrink-0 text-muted-foreground"
            aria-expanded={listOpen}
            aria-label={
              listOpen
                ? translate('goalsTodos.hideList', 'Hide to-do list')
                : translate('goalsTodos.showList', 'Show to-do list')
            }
            onClick={() => setListOpen((value) => !value)}
          >
            <ChevronDown
              className={cn('size-3.5 transition-transform', listOpen && 'rotate-180')}
            />
          </Button>
        }
      />
      {listOpen ? <SessionActivityTodoList todos={view.todos} /> : null}
    </div>
  )
}

/** The Goal row and To-do section of the session info card, from an already-built view. */
export function SessionGoalTodosSection({
  view,
  progress,
  asks
}: {
  view: SessionGoalTodosView
  /** The milestone checklist, when the session's pull requests give it one. */
  progress?: ReactNode
  /** The person's asks: the to-do list every session has, whatever its work. */
  asks?: ReactNode
}): React.JSX.Element {
  // Why no empty section: most sessions publish no list, and "No to-do list yet" read as a fault.
  const showTodos = Boolean(asks) || view.todos.length > 0 || view.reading
  return (
    <>
      <GoalRow goal={view.goal} reading={view.reading} />
      {progress ? (
        <SessionDetailsSection id="progress" label={translate('sessionProgress.label', 'Progress')}>
          {progress}
        </SessionDetailsSection>
      ) : null}
      {showTodos ? (
        <SessionDetailsSection id="todos" label={translate('goalsTodos.todoLabel', 'To-do')}>
          {asks}
          {/* Why folded under asks: the AI's own steps are detail inside the current ask. */}
          {asks && view.todos.length === 0 ? null : (
            <TodoBody
              key={progress || asks ? 'folded' : 'open'}
              view={view}
              folded={Boolean(progress || asks)}
            />
          )}
        </SessionDetailsSection>
      ) : null}
    </>
  )
}

/**
 * The session info card's goal, progress and to-do list. Read-only: the goal is the session's
 * first prompt, progress is GitHub's word on the pull requests the AI named, and the to-do list is
 * the person's own asks with what each produced — plus the AI's own steps when it published any.
 */
export function SessionGoalTodosDetails({
  session,
  messages,
  active,
  goals,
  outputs
}: {
  session: SidebarSession
  messages?: readonly NativeChatMessage[]
  /** Whether the info card is open; a closed card asks for no reads. */
  active: boolean
  /** The conversation's goals from its pull requests, read by the mount that owns them. */
  goals?: readonly SessionGoalGroup[]
  /** Everything the session produced, to show under the ask that produced it. */
  outputs?: SessionOutputs
}): React.JSX.Element {
  const view = useSessionGoalTodos(session, messages, active)
  const paneState = useAppStore((state) =>
    session.paneKey ? state.agentStatusByPaneKey[session.paneKey]?.state : undefined
  )
  const asks = useMemo(() => (active && messages ? sessionAsks(messages) : []), [active, messages])
  const askOutputs = useMemo(() => sessionAskOutputs(asks, outputs?.cards ?? []), [asks, outputs])
  return (
    <SessionGoalTodosSection
      view={view}
      asks={
        asks.length > 0 ? (
          <SessionAsksList asks={asks} outputs={askOutputs} paneState={paneState} />
        ) : undefined
      }
      progress={
        goals && goals.length > 0 ? (
          <SessionGoalProgress groups={goals} onApprove={approveSessionGoal} />
        ) : undefined
      }
    />
  )
}
