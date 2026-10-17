import { SessionDataStatusLine } from '@/components/session-data-status'
import React, { useMemo, useRef, useState } from 'react'
import { ChevronRight, SkipForward } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { DecisionLiveQuestion } from '@/components/needs-you/DecisionLiveQuestion'
import { DecisionScoreChips } from '@/components/needs-you/DecisionScoreChips'
import { useSessionDecisionQueue } from '@/components/needs-you/use-session-decisions'
import {
  decisionDelivery,
  deliverDecisionAsMessage,
  type DecisionDelivery
} from '@/components/needs-you/session-decision-answer'
import { NativeChatQuestionCard } from '@/components/native-chat/NativeChatQuestionCard'
import { useSidebarSessions } from '@/components/sidebar/session-folders/use-sidebar-sessions'
import { translate } from '@/i18n/i18n'
import { activateSidebarSession } from '@/lib/activate-sidebar-session'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { SESSION_DECISIONS_RPC, type SessionDecision } from '../../../../shared/session-decisions'
import type { AskAnswerSelection } from '../../../../shared/native-chat-ask'
import { WorkSectionTitle } from './WorkSectionTitle'
import { useDecisionDigitKeys } from './use-decision-digit-keys'

function ago(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000))
  if (minutes < 1) {
    return translate('decisions.justNow', 'just now')
  }
  if (minutes < 60) {
    return translate('decisions.minutesAgo', '{{count}} min ago', {
      count: minutes
    })
  }
  const hours = Math.round(minutes / 60)
  return hours < 48
    ? translate('decisions.hoursAgo', '{{count}} h ago', { count: hours })
    : translate('decisions.daysAgo', '{{count}} days ago', {
        count: Math.round(hours / 24)
      })
}

function sessionFor(
  sessions: readonly SidebarSession[],
  decision: SessionDecision
): SidebarSession | null {
  const sessionId = decision.providerSession?.id
  return (
    sessions.find((session) => session.paneKey === decision.paneKey) ??
    (sessionId
      ? sessions.find((session) => session.providerSession?.id === sessionId)
      : undefined) ??
    null
  )
}

function openSession(session: SidebarSession): void {
  void activateSidebarSession(session).then((opened) => {
    if (!opened) {
      toast.error(
        translate(
          'work.openSessionFailed',
          'This session could not be opened; check its workspace.'
        )
      )
    }
  })
}

function DeliveryNote({
  kind,
  ended
}: {
  kind: DecisionDelivery['kind']
  ended: boolean
}): React.JSX.Element | null {
  if (kind === 'keys') {
    return null
  }
  const text =
    kind === 'message'
      ? translate(
          'decisions.resumedNote',
          'This session was resumed after it asked. Your answer goes to it as your next message.'
        )
      : kind === 'resume'
        ? translate(
            'decisions.endedNote',
            'This session ended while it waited. Answering resumes it in a background tab with your answer.'
          )
        : ended
          ? translate(
              'decisions.unreachableNote',
              'This question can’t be answered from here. Open the session to answer it, or dismiss it.'
            )
          : translate(
              'decisions.answerInSessionNote',
              'This session may still be waiting on it. Open the session to answer it there.'
            )
  return (
    <p className="rounded-md border border-status-warning-border bg-status-warning-background px-2 py-1 text-xs text-status-warning">
      {text}
    </p>
  )
}

/** The agent's own words just before it asked, folded to a few lines. */
function AgentContext({ text }: { text: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="text-xs text-muted-foreground">
      <p className={open ? 'whitespace-pre-wrap' : 'line-clamp-3 whitespace-pre-wrap'}>{text}</p>
      <button
        type="button"
        className="mt-0.5 text-[11px] underline-offset-2 hover:underline"
        onClick={() => setOpen((value) => !value)}
      >
        {open
          ? translate('decisions.less', 'Less')
          : translate('decisions.more', 'More of what the agent said')}
      </button>
    </div>
  )
}

/** The delivery path as a stable primitive, so the store selector never returns a new object. */
function useDeliveryShape(decision: SessionDecision | null): string | null {
  return useAppStore((state) => {
    if (!decision) {
      return null
    }
    const delivery = decisionDelivery(state, decision)
    return delivery.kind === 'keys' ? `keys\n${delivery.tabId}\n${delivery.ptyId}` : delivery.kind
  })
}

function shapeKind(shape: string): DecisionDelivery['kind'] {
  return shape.split('\n')[0] as DecisionDelivery['kind']
}

function QuestionFor({
  decision,
  shape,
  onAnswered,
  onSkip
}: {
  decision: SessionDecision
  shape: string
  onAnswered: () => void
  onSkip: () => void
}): React.JSX.Element {
  const baseline = useAppStore((state) => state.agentStatusByPaneKey[decision.paneKey])
  const [sending, setSending] = useState(false)
  const prompt = useMemo(() => ({ questions: decision.questions }), [decision.questions])
  const [kind, tabId, ptyId] = shape.split('\n')
  if (kind === 'keys' && baseline && tabId && ptyId) {
    return (
      <DecisionLiveQuestion
        key={decision.key}
        paneKey={decision.paneKey}
        tabId={tabId}
        ptyId={ptyId}
        baseline={baseline}
        onAnswered={onAnswered}
      />
    )
  }
  if (kind !== 'message' && kind !== 'resume') {
    return (
      <p className="text-sm">
        {decision.questions.map((question) => question.question).join(' · ')}
      </p>
    )
  }
  const answer = (selections: AskAnswerSelection[]): void => {
    // Why re-read: the path is chosen at the moment of answering, from the store as it is now.
    const delivery = decisionDelivery(useAppStore.getState(), decision)
    if (delivery.kind !== 'message' && delivery.kind !== 'resume') {
      toast.message(
        translate(
          'decisions.pathChanged',
          'This session changed while you answered. Check the question again.'
        )
      )
      return
    }
    setSending(true)
    void deliverDecisionAsMessage(decision, delivery, prompt, selections)
      .then((queued) => {
        if (queued) {
          toast.success(
            translate(
              'decisions.queued',
              'Answer queued. The session picks it up when it is ready.'
            )
          )
          onAnswered()
        } else {
          toast.error(
            translate(
              'decisions.notQueued',
              'The session could not be resumed. Nothing was sent; open it to answer.'
            )
          )
        }
      })
      .catch(() =>
        toast.error(
          translate(
            'decisions.notQueued',
            'The session could not be resumed. Nothing was sent; open it to answer.'
          )
        )
      )
      .finally(() => setSending(false))
  }
  return (
    <NativeChatQuestionCard
      key={decision.key}
      prompt={prompt}
      isSubmitting={sending}
      onAnswer={answer}
      onCancel={onSkip}
    />
  )
}

/**
 * Work › "Needs You — Questions": one question a session is blocked on at a time, highest value
 * per second first (JEV Impact against Effort), answered with the terminal's own controls. An
 * answer shows the next one at once; a session that died waiting is resumed with the answer.
 */
export function WorkDecisionsBox(): React.JSX.Element {
  const queue = useSessionDecisionQueue()
  const sessions = useSidebarSessions()
  const shape = useDeliveryShape(queue.current)
  const box = useRef<HTMLDivElement>(null)
  useDecisionDigitKeys(box)
  const decision = queue.current
  const session = decision ? sessionFor(sessions, decision) : null
  const title =
    session?.label ?? decision?.questions[0]?.header ?? translate('decisions.aSession', 'A session')
  const dismiss = (key: string): void => {
    void callRuntimeRpc({ kind: 'local' }, SESSION_DECISIONS_RPC.dismiss, {
      key
    })
      .then(() => queue.answered(key))
      .catch(() =>
        toast.error(translate('decisions.dismissFailed', 'Could not dismiss it; try again.'))
      )
  }
  return (
    <section
      aria-label={translate('decisions.title', 'Needs You — Questions')}
      data-work-decisions={queue.total}
    >
      <WorkSectionTitle
        title={translate('decisions.title', 'Needs You — Questions')}
        sub={
          !queue.loaded
            ? translate('work.loading', 'Loading…')
            : queue.failed && queue.total === 0
              ? ''
              : queue.total === 0
                ? translate('decisions.none', 'no session is waiting on a question')
                : translate('decisions.position', '{{position}} of {{total}}', {
                    position: queue.position,
                    total: queue.total
                  })
        }
      />
      <SessionDataStatusLine
        status={queue.status}
        issue={queue.issue}
        lastSuccessAt={queue.lastSuccessAt}
      />
      {decision && shape ? (
        <div
          ref={box}
          className="space-y-2 rounded-lg border bg-card px-3 py-2.5"
          data-work-decision={decision.key}
        >
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium" title={title}>
                {title}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {[
                  session?.workspaceLabel,
                  decision.agent,
                  translate('decisions.asked', 'asked {{when}}', {
                    when: ago(decision.askedAt)
                  })
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
            <DecisionScoreChips scores={decision.scores} unavailable={decision.scoreUnavailable} />
            {queue.total > 1 ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => queue.skip(decision.key)}
                title={translate(
                  'decisions.skipHint',
                  'Show the next question; this one waits at the end'
                )}
              >
                <SkipForward className="size-3" aria-hidden />
                {translate('decisions.skip', 'Skip')}
              </Button>
            ) : null}
            {decision.endedAt !== null ? (
              <Button size="xs" variant="ghost" onClick={() => dismiss(decision.key)}>
                {translate('decisions.dismiss', 'Dismiss')}
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="outline"
              disabled={!session}
              onClick={() => session && openSession(session)}
            >
              {translate('decisions.openSession', 'Open session')}
              <ChevronRight className="size-3" aria-hidden />
            </Button>
          </div>
          {decision.context ? <AgentContext text={decision.context} /> : null}
          <DeliveryNote kind={shapeKind(shape)} ended={decision.endedAt !== null} />
          <QuestionFor
            decision={decision}
            shape={shape}
            onAnswered={() => queue.answered(decision.key)}
            onSkip={() => queue.skip(decision.key)}
          />
          <p className="text-[11px] text-muted-foreground">
            {translate('decisions.keysHint', 'Keys: 1–9 picks an option · Skip shows the next one')}
          </p>
        </div>
      ) : null}
    </section>
  )
}
