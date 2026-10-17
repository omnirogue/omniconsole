import { useEffect, useId, useRef } from 'react'
import { ArrowLeft, ChevronDown, ChevronRight } from 'lucide-react'
import { AgentQuestionIcon } from '@/components/AgentQuestionIcon'
import { NeedsYouQuestionList } from '@/components/needs-you/NeedsYouQuestionList'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { ConversationFleetSidebarGroup } from '@/lib/conversation-fleet-sidebar'
import {
  SESSION_FOCUS_NEEDS_YOU_KEY,
  sessionFocusNeedsYouCount,
  sessionFocusTopQuestion,
  type SessionFocusFolderLine
} from '@/lib/session-focus-lines'
import { SESSION_OTHER_GROUP_KEY } from '@/lib/session-sidebar-tree'
import { cn } from '@/lib/utils'
import { SessionFolderStatusStrip, SessionFolderTally } from './SessionFolderTally'
import { SessionProjectRollup } from './SessionProjectRollup'
import { useSessionFolders } from '@/store/session-folders'
import { SessionSidebarGroupIcon } from './SessionSidebarGroupIcon'
import {
  noteSessionFocusActivity,
  SESSION_FOCUS_NEEDS_YOU_PAGE,
  type SessionFocusView as FocusView
} from './use-session-focus-view'

const LINE_CLASS =
  'relative flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1 text-left text-[12px] outline-none hover:bg-worktree-sidebar-accent focus-visible:ring-2 focus-visible:ring-worktree-sidebar-ring motion-safe:transition-colors'

function countLabel(count: number, one: string, many: string, oneText: string, manyText: string) {
  return count === 1 ? translate(one, oneText) : translate(many, manyText, { count })
}

export function sessionFocusEverythingElseLabel(
  sessions: number,
  folders: number,
  byLens = false
): string {
  const sessionText = countLabel(
    sessions,
    'conversations.focus.sessionsOne',
    'conversations.focus.sessionsMany',
    '1 session',
    '{{count}} sessions'
  )
  if (folders === 0) {
    return translate('conversations.focus.everythingElse', 'Everything else · {{sessions}}', {
      sessions: sessionText
    })
  }
  return translate(
    'conversations.focus.everythingElseInFolders',
    'Everything else · {{sessions}} in {{folders}}',
    {
      sessions: sessionText,
      folders: byLens
        ? countLabel(
            folders,
            'conversations.focus.groupsOne',
            'conversations.focus.groupsMany',
            '1 group',
            '{{count}} groups'
          )
        : countLabel(
            folders,
            'conversations.focus.foldersOne',
            'conversations.focus.foldersMany',
            '1 folder',
            '{{count}} folders'
          )
    }
  )
}

/**
 * The Conversations list, and by default the focus view around it (Session Focus Plan §11): at
 * most five lines however many sessions exist — Needs you, the folders that matter now, and
 * Everything else, which opens the full tree in place.
 */
export function SessionFocusView<G extends ConversationFleetSidebarGroup>({
  focus,
  listRef,
  onKeyDown,
  children
}: {
  focus: FocusView<G>
  listRef: React.RefObject<HTMLDivElement | null>
  onKeyDown: React.KeyboardEventHandler<HTMLDivElement>
  children: React.ReactNode
}): React.JSX.Element {
  const listId = useId()
  // Why: a switch unmounts the control that was pressed, so keyboard focus is handed on by hand.
  const pending = useRef<string | null>(null)
  const wasOpen = useRef(focus.needsYouOpen)
  useEffect(() => {
    // Why: folding Needs you from its heading drops focus with the heading; the line takes it.
    const selector =
      pending.current ??
      (wasOpen.current && !focus.needsYouOpen && document.activeElement === document.body
        ? '[data-session-focus-line="needs-you"]'
        : null)
    pending.current = null
    wasOpen.current = focus.needsYouOpen
    if (selector) {
      listRef.current?.parentElement?.querySelector<HTMLElement>(selector)?.focus()
    }
  })
  const act = (selector: string, run: () => void) => () => {
    pending.current = selector
    run()
  }
  // Why: a drill-in from a Focus line lasts while the person is using the list.
  const activity = focus.drilled ? noteSessionFocusActivity : undefined
  const listbox = (
    <div
      ref={listRef}
      id={listId}
      role="listbox"
      // Why the marker: this list is always mounted, so Escape belongs to the page, not to it.
      data-sidebar-persistent-list
      aria-multiselectable="true"
      aria-label={translate('conversations.conversationList', 'Conversation list')}
      // Why: the list itself is the keyboard surface for range selection; -1 keeps it out of
      // the Tab order while the rows' roving tabIndex stays the way in.
      tabIndex={-1}
      onKeyDown={(event) => {
        activity?.()
        onKeyDown(event)
      }}
      onPointerDown={activity}
      onPointerMove={activity}
      onWheel={activity}
      className={cn(
        'worktree-sidebar-scrollbar min-h-0 overflow-y-auto px-2 outline-none',
        // Why: in focus the list holds only the opened Needs you rows, so the lines follow it.
        focus.mode === 'focus' ? 'flex-initial' : 'flex-1 pb-2'
      )}
    >
      {children}
    </div>
  )
  if (focus.mode === 'off') {
    return listbox
  }
  if (focus.mode === 'full' || !focus.lines) {
    return (
      <>
        <div className="px-2 pb-1">
          <Button
            variant="ghost"
            size="xs"
            data-session-focus-back=""
            onClick={act('[data-session-focus-everything-else]', focus.showFocus)}
          >
            <ArrowLeft aria-hidden />
            {translate('conversations.focus.backToFocus', 'Back to focus view')}
          </Button>
        </div>
        {listbox}
      </>
    )
  }
  const { needsYou, folders, everythingElse, byLens } = focus.lines
  const question = needsYou ? sessionFocusTopQuestion(needsYou) : ''
  const needsYouCount = needsYou ? sessionFocusNeedsYouCount(needsYou) : 0
  return (
    <>
      {needsYou && !focus.needsYouOpen ? (
        <div className="px-2">
          <button
            type="button"
            data-session-focus-line="needs-you"
            aria-expanded={false}
            aria-controls={listId}
            aria-label={translate(
              'conversations.focus.needsYouAria',
              'Needs you: {{count}}. Most urgent: {{question}}',
              { count: needsYouCount, question }
            )}
            title={question}
            onClick={act(
              `[data-session-group="${SESSION_FOCUS_NEEDS_YOU_KEY}"] button[aria-expanded]`,
              focus.toggleNeedsYou
            )}
            className={cn(LINE_CLASS, 'bg-agent-question/10')}
          >
            <ChevronDown
              aria-hidden
              className="size-3.5 shrink-0 -rotate-90 text-muted-foreground"
            />
            <AgentQuestionIcon className="size-3.5 shrink-0" />
            <span className="shrink-0 font-semibold tabular-nums text-agent-question-text">
              {translate('conversations.focus.needsYou', 'Needs you · {{count}}', {
                count: needsYouCount
              })}
            </span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{question}</span>
          </button>
        </div>
      ) : null}
      {needsYou && focus.needsYouOpen ? (
        <NeedsYouQuestionList sessions={focus.questionSessions} />
      ) : null}
      {listbox}
      {focus.needsYouOpen && focus.needsYouMore > 0 ? (
        <div className="px-2">
          <Button
            variant="ghost"
            size="xs"
            data-session-focus-more=""
            className="text-muted-foreground"
            onClick={focus.showMoreNeedsYou}
          >
            {translate('conversations.viewPicker.showMore', 'Show {{count}} more', {
              count: Math.min(SESSION_FOCUS_NEEDS_YOU_PAGE, focus.needsYouMore)
            })}
          </Button>
        </div>
      ) : null}
      <div
        role="group"
        aria-label={translate('conversations.focus.linesLabel', 'Focus view')}
        className="flex-none space-y-px px-2 pb-2"
      >
        {folders.map((line) => (
          <SessionFocusFolderButton
            key={line.key}
            line={line}
            onOpen={act('[data-session-focus-back]', () =>
              focus.showFull(line.folder || line.lens ? line.key : SESSION_OTHER_GROUP_KEY)
            )}
          />
        ))}
        <button
          type="button"
          data-session-focus-line="everything-else"
          data-session-focus-everything-else=""
          onClick={act('[data-session-focus-back]', () => focus.showFull())}
          className={cn(LINE_CLASS, 'text-muted-foreground')}
        >
          <ChevronRight aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {sessionFocusEverythingElseLabel(
              everythingElse.sessions,
              everythingElse.folders,
              byLens
            )}
          </span>
        </button>
      </div>
    </>
  )
}

function SessionFocusFolderButton({
  line,
  onOpen
}: {
  line: SessionFocusFolderLine
  onOpen: () => void
}): React.JSX.Element {
  const folderId = line.lens ? undefined : line.folder?.id
  const isProject = useSessionFolders((state) =>
    Boolean(folderId && state.metadata.projects?.[folderId])
  )
  return (
    <button
      type="button"
      data-session-focus-line="folder"
      data-session-focus-folder={line.key}
      data-session-focus-rank={line.rank}
      title={line.label}
      onClick={onOpen}
      className={LINE_CLASS}
    >
      <SessionFolderStatusStrip tally={line.tally} />
      <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <SessionSidebarGroupIcon kind={line.lens ?? (line.folder ? 'folder' : 'workspace')} />
      <span className="min-w-0 flex-1 truncate font-semibold">{line.label}</span>
      {isProject ? (
        <SessionProjectRollup tally={line.tally} />
      ) : (
        <SessionFolderTally tally={line.tally} />
      )}
    </button>
  )
}
