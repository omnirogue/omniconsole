import React, { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Reply } from 'lucide-react'
import { NeedsYouQuestionRow } from '@/components/needs-you/NeedsYouQuestionRow'
import { useSessionQuestionsInline } from '@/components/needs-you/use-session-question-rows'
import {
  cancelQueuedSession,
  useQueuedSessionRowKeys
} from '@/components/sidebar/session-folders/session-queue-state'
import { Button } from '@/components/ui/button'
import {
  SessionSidebarTreeRowItem,
  type SessionTreeRowHandlers
} from '@/components/sidebar/session-folders/SessionSidebarTreeRowItem'
import { translate } from '@/i18n/i18n'
import { openSidebarSession } from '@/lib/open-sidebar-session'
import { canReplyToSession } from '@/lib/session-reply-send'
import type {
  SessionProjectThreadGroup,
  SessionProjectThreadGroupKey
} from '@/lib/session-project-thread-groups'
import type { SessionProjectThread } from '@/lib/session-project-threads'
import { cn } from '@/lib/utils'
import { sessionProjectThreadGroupLabel } from './session-project-status-labels'
import { SessionProjectThreadReplyForm } from './SessionProjectThreadReply'
import type { SessionProjectRows } from './use-session-project-rows'
import {
  SessionProjectThreadOutputs,
  type SessionProjectReviewAction
} from './SessionProjectThreadOutputs'

/** Done, Failed and Waiting start folded: finished or parked work is read on demand. */
const FOLDED_BY_DEFAULT: ReadonlySet<SessionProjectThreadGroupKey> = new Set([
  'done',
  'stopped',
  'waiting',
  'idle'
])

/** One thread's row: the sidebar's own row, its chips, its pending question and a reply field. */
function SessionProjectThreadRow({
  thread,
  data,
  handlers,
  queued,
  questionsInline,
  onReview
}: {
  thread: SessionProjectThread
  data: SessionProjectRows
  handlers: SessionTreeRowHandlers
  queued: boolean
  questionsInline: boolean
  onReview?: SessionProjectReviewAction
}): React.JSX.Element {
  const [replying, setReplying] = useState(false)
  const { row, isCoordinator } = thread
  const { session } = row
  const canReply = canReplyToSession(session)
  return (
    <li
      data-session-project-thread={session.rowKey}
      data-session-project-coordinator={isCoordinator ? '' : undefined}
      className="rounded-md border bg-card px-1"
    >
      <SessionSidebarTreeRowItem
        row={row}
        handlers={handlers}
        current={false}
        selected={false}
        queued={queued}
        chain={data.chainsByRowKey.get(session.rowKey) ?? null}
        now={row.waitingUntil ? data.now : undefined}
      />
      <span className="flex flex-wrap items-center gap-1 px-2 pb-1 empty:hidden">
        {isCoordinator ? (
          <span
            className="rounded-full border px-1.5 py-px text-[10px] text-muted-foreground"
            data-session-project-chat-mark=""
          >
            {translate('projects.chat.mark', 'Project chat')}
          </span>
        ) : null}
        {thread.origin ? (
          <span
            className="max-w-full truncate rounded-full border px-1.5 py-px text-[10px] text-muted-foreground"
            title={thread.origin.task}
            data-session-project-origin={thread.origin.fromChat ? 'chat' : 'thread'}
          >
            {thread.origin.fromChat
              ? translate('projects.origin.chat', 'From the chat: {{task}}', {
                  task: thread.origin.task
                })
              : translate('projects.origin.task', 'For: {{task}}', { task: thread.origin.task })}
          </span>
        ) : null}
        <SessionProjectThreadOutputs thread={thread} canSend={canReply} onReview={onReview} />
        {canReply && !replying ? (
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto h-5 px-1.5 text-[10px] text-muted-foreground"
            onClick={() => setReplying(true)}
            data-session-project-reply-open=""
          >
            <Reply className="size-3" aria-hidden />
            {translate('projects.reply.open', 'Reply')}
          </Button>
        ) : null}
      </span>
      {questionsInline && session.paneKey ? (
        <ul className="empty:hidden">
          <NeedsYouQuestionRow paneKey={session.paneKey} />
        </ul>
      ) : null}
      {replying ? (
        <SessionProjectThreadReplyForm session={session} onClose={() => setReplying(false)} />
      ) : null}
    </li>
  )
}

/** The sidebar's own rows, so state glyph, caption, hover card and open behave as there. */
export function SessionProjectThreadRows({
  threads,
  data,
  onReview
}: {
  threads: readonly SessionProjectThread[]
  data: SessionProjectRows
  /** Starts a Reviewer thread on a ready review; absent where no project launch is at hand. */
  onReview?: SessionProjectReviewAction
}): React.JSX.Element {
  const queued = useQueuedSessionRowKeys()
  const questionsInline = useSessionQuestionsInline()
  const handlers = useMemo<SessionTreeRowHandlers>(
    () => ({
      open: openSidebarSession,
      cancelQueue: (session) => cancelQueuedSession(session.rowKey)
    }),
    []
  )
  return (
    <ul className="space-y-px" data-session-project-threads={threads.length}>
      {threads.map((thread) => (
        <SessionProjectThreadRow
          key={thread.row.session.rowKey}
          thread={thread}
          data={data}
          handlers={handlers}
          queued={queued.has(thread.row.session.rowKey)}
          questionsInline={questionsInline}
          onReview={onReview}
        />
      ))}
    </ul>
  )
}

export function SessionProjectThreadList({
  groups,
  data,
  total,
  filtered,
  onReview
}: {
  groups: readonly SessionProjectThreadGroup[]
  data: SessionProjectRows
  /** Threads shown after the filters; the heading counts these. */
  total: number
  /** Whether a filter or search is narrowing the list, so an empty list says so. */
  filtered: boolean
  onReview?: SessionProjectReviewAction
}): React.JSX.Element {
  const [folded, setFolded] = useState<ReadonlySet<SessionProjectThreadGroupKey>>(
    () => new Set(FOLDED_BY_DEFAULT)
  )
  const toggle = (key: SessionProjectThreadGroupKey): void =>
    setFolded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  return (
    <section
      aria-label={translate('projects.page.threads', 'Threads')}
      data-session-project-thread-count={total}
      className="space-y-4"
    >
      <h2 className="text-sm font-semibold">
        {translate('projects.page.threadsCount', '{{count}} threads', {
          count: total
        })}
      </h2>
      {total === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground">
          {filtered
            ? translate('projects.page.noThreadsMatch', 'No threads match these filters.')
            : translate(
                'projects.page.noThreads',
                'No threads yet. Start one with New thread, or describe the work above and the threads are prepared for you.'
              )}
        </p>
      ) : null}
      {groups.map((group) => {
        const isFolded = folded.has(group.key)
        const label = sessionProjectThreadGroupLabel(group.key)
        return (
          <div key={group.key} data-session-project-group={group.key}>
            <button
              type="button"
              aria-expanded={!isFolded}
              onClick={() => toggle(group.key)}
              className={cn(
                'mb-1.5 flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-xs font-semibold',
                group.key === 'needsYou' && group.threads.length > 0
                  ? 'text-agent-question-text'
                  : 'text-muted-foreground'
              )}
            >
              {isFolded ? (
                <ChevronRight className="size-3.5" aria-hidden />
              ) : (
                <ChevronDown className="size-3.5" aria-hidden />
              )}
              <span>{label}</span>
              <span
                className="tabular-nums"
                data-session-project-group-count={group.threads.length}
              >
                {group.threads.length}
              </span>
            </button>
            {isFolded ? null : group.threads.length > 0 ? (
              <SessionProjectThreadRows threads={group.threads} data={data} onReview={onReview} />
            ) : (
              <p className="px-2 text-xs text-muted-foreground">
                {translate('projects.page.nothingNeedsYou', 'Nothing needs you in this project.')}
              </p>
            )}
          </div>
        )
      })}
    </section>
  )
}
