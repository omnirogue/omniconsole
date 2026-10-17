import React, { useMemo, useState, type KeyboardEvent } from 'react'
import { ChevronRight, Send } from 'lucide-react'
import { toast } from 'sonner'
import { AgentQuestionIcon } from '@/components/AgentQuestionIcon'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { activateSidebarSession } from '@/lib/activate-sidebar-session'
import { conversationSourceForSession } from '@/lib/conversation-source-for-session'
import type { SidebarSession } from '@/lib/sidebar-session-types'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { PROMPT_QUEUE_MAX_TEXT_LENGTH } from '../../../../shared/prompt-queue-types'
import { pendingSessionAsk, sessionQuestionSummary } from '../../../../shared/session-questions'
import { NeedsYouQuestionRow } from '../needs-you/NeedsYouQuestionRow'
import { useSessionQuestionsInline } from '../needs-you/use-session-question-rows'
import { PromptQueueStrip } from '../prompt-queue/PromptQueueStrip'
import { usePromptQueue } from '../prompt-queue/use-prompt-queue'

export type LiveSessionSteeringBarProps = {
  /** The team sessions this person may steer; the caller decides who is authorized. */
  sessions: readonly SidebarSession[]
  /** Row to start on (e.g. the session on screen); the person can switch from there. */
  initialRowKey?: string | null
  className?: string
}

/** A row with a live address: closed or unavailable rows have nothing to answer or instruct. */
function isSteerable(session: SidebarSession): boolean {
  return !session.unavailable && (session.paneKey !== null || session.kind === 'structured')
}

function openSession(session: SidebarSession): void {
  void activateSidebarSession(session).then((opened) => {
    if (!opened) {
      toast.error(
        translate('needsYou.openFailed', 'This session could not be opened; check its workspace.')
      )
    }
  })
}

/** Row keys whose pane waits on a question, as one string so the selector result stays stable. */
function useAskingRowKeys(sessions: readonly SidebarSession[]): ReadonlySet<string> {
  const joined = useAppStore((state) =>
    sessions
      .filter((session) => {
        const status = session.paneKey ? state.agentStatusByPaneKey[session.paneKey] : undefined
        return status ? pendingSessionAsk(status) !== null : false
      })
      .map((session) => session.rowKey)
      .join('\n')
  )
  return useMemo(() => new Set(joined ? joined.split('\n') : []), [joined])
}

function useQuestionSummary(paneKey: string | null): string | null {
  return useAppStore((state) => {
    const status = paneKey ? state.agentStatusByPaneKey[paneKey] : undefined
    const ask = status ? pendingSessionAsk(status) : null
    return ask ? sessionQuestionSummary(ask) : null
  })
}

function SessionChip({
  session,
  selected,
  asking,
  onSelect
}: {
  session: SidebarSession
  selected: boolean
  asking: boolean
  onSelect: (rowKey: string) => void
}): React.JSX.Element {
  return (
    <Button
      type="button"
      size="xs"
      variant={selected ? 'secondary' : 'ghost'}
      aria-pressed={selected}
      className="max-w-48 shrink-0"
      onClick={() => onSelect(session.rowKey)}
      title={`${session.label} · ${session.workspaceLabel}`}
      data-steering-session={session.rowKey}
    >
      {asking ? (
        <AgentQuestionIcon
          className="size-3 shrink-0"
          aria-label={translate('sessionSteering.asking', 'Waiting on your answer')}
        />
      ) : null}
      <span className="truncate">{session.label}</span>
    </Button>
  )
}

/**
 * A mid-flight instruction for one conversation, sent through its prompt queue: the host admits
 * the write and delivers it as the agent's next message, never as keystrokes into a running turn.
 */
function InstructionComposer({ session }: { session: SidebarSession }): React.JSX.Element {
  const source = useMemo(() => conversationSourceForSession(session), [session])
  const { enqueue, error } = usePromptQueue(source)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  if (!source) {
    return (
      <p className="text-xs text-muted-foreground" data-steering-unreachable="">
        {translate(
          'sessionSteering.otherComputer',
          'This session runs on another computer. Open it to send an instruction there.'
        )}
      </p>
    )
  }

  const send = async (): Promise<void> => {
    const value = text.trim()
    if (!value || busy) {
      return
    }
    setBusy(true)
    setFailure(null)
    try {
      await enqueue(value)
      setText('')
      toast.success(
        translate('sessionSteering.queued', 'Sent to {{label}} as its next message.', {
          label: session.label
        })
      )
    } catch (err) {
      // Why keep the text: a refused instruction must not be lost; the reason shows below.
      setFailure(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void send()
    }
  }

  const reason = failure ?? error
  return (
    <div className="space-y-1.5" data-steering-composer="">
      <div className="flex items-end gap-2">
        <Textarea
          rows={2}
          value={text}
          maxLength={PROMPT_QUEUE_MAX_TEXT_LENGTH}
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={keyDown}
          aria-label={translate('sessionSteering.instructionLabel', 'Instruction for {{label}}', {
            label: session.label
          })}
          placeholder={translate(
            'sessionSteering.instructionPlaceholder',
            'Steer this agent… (Enter sends, Shift+Enter new line)'
          )}
          className="min-h-0 resize-none text-xs"
        />
        <Button
          type="button"
          size="sm"
          disabled={busy || !text.trim()}
          onClick={() => void send()}
          aria-label={translate('sessionSteering.send', 'Send instruction')}
        >
          <Send className="size-3.5" aria-hidden />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {translate(
          'sessionSteering.deliveryHint',
          'Delivered as its next message as soon as the agent can take one.'
        )}
      </p>
      {reason ? (
        <p className="text-xs text-destructive" role="alert">
          {reason}
        </p>
      ) : null}
      <PromptQueueStrip source={source} />
    </div>
  )
}

function SelectedSession({ session }: { session: SidebarSession }): React.JSX.Element {
  const inline = useSessionQuestionsInline()
  const summary = useQuestionSummary(session.paneKey)
  return (
    <div className="space-y-2" data-steering-selected={session.rowKey}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{session.label}</div>
          <div className="truncate text-xs text-muted-foreground">
            {session.workspaceLabel} · {session.agent}
          </div>
        </div>
        <Button size="xs" variant="ghost" onClick={() => openSession(session)}>
          {translate('needsYou.openSession', 'Open')}
          <ChevronRight className="size-3" aria-hidden />
        </Button>
      </div>
      {session.paneKey && summary ? (
        inline ? (
          <ul aria-label={translate('sessionSteering.questionLabel', 'Question from this agent')}>
            <NeedsYouQuestionRow paneKey={session.paneKey} />
          </ul>
        ) : (
          <p className="text-sm" data-steering-question-summary="">
            {summary}
          </p>
        )
      ) : null}
      {/* Why the key: a draft belongs to the agent it was written for, never the next one picked. */}
      <InstructionComposer key={session.rowKey} session={session} />
    </div>
  )
}

/**
 * Live teammate↔agent steering: pick any authorized team session, answer the question it waits
 * on (guarded like Needs you, paired computers through their owner), or queue an instruction
 * that reaches it mid-flight as its next message.
 */
export function LiveSessionSteeringBar({
  sessions,
  initialRowKey = null,
  className
}: LiveSessionSteeringBarProps): React.JSX.Element | null {
  const steerable = useMemo(() => sessions.filter(isSteerable), [sessions])
  const asking = useAskingRowKeys(steerable)
  // Why stable sort: sessions waiting on the person come first, the caller's order otherwise.
  const ordered = useMemo(
    () =>
      [...steerable].sort((a, b) => Number(asking.has(b.rowKey)) - Number(asking.has(a.rowKey))),
    [steerable, asking]
  )
  const [chosen, setChosen] = useState<string | null>(initialRowKey)
  const selected = ordered.find((session) => session.rowKey === chosen) ?? ordered[0] ?? null

  if (!selected) {
    return null
  }
  return (
    <section
      className={cn('space-y-2 rounded-lg border bg-card px-3 py-2', className)}
      aria-label={translate('sessionSteering.label', 'Steer team sessions')}
      data-live-session-steering-bar=""
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-xs font-medium text-muted-foreground">
          {translate('sessionSteering.title', 'Steer')}
        </span>
        <div
          className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
          role="group"
          aria-label={translate('sessionSteering.sessions', 'Team sessions')}
        >
          {ordered.map((session) => (
            <SessionChip
              key={session.rowKey}
              session={session}
              selected={session.rowKey === selected.rowKey}
              asking={asking.has(session.rowKey)}
              onSelect={setChosen}
            />
          ))}
        </div>
        {asking.size > 0 ? (
          <span className="shrink-0 text-xs text-agent-question">
            {translate('sessionSteering.askingCount', '{{count}} waiting', {
              count: asking.size
            })}
          </span>
        ) : null}
      </div>
      <SelectedSession session={selected} />
    </section>
  )
}
