import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type {
  NextStepSuggestion,
  NextStepSuggestionSet
} from '../../../../shared/next-step-suggestions'
import type { ConversationSource } from '../../../../shared/conversation-source'
import { acknowledgeNextStepKeepGoingStop } from './next-steps-pending-store'
import type { NextStepsDecideResult } from '../../../../shared/next-step-suggestions-rpc'
import { saveNextStepsForLater } from './next-steps-save-for-later'
import {
  NextStepsKeepGoingControl,
  NextStepsKeepGoingStatus,
  stopKeepGoingForPersonAction
} from './NextStepsKeepGoing'
import { NextStepsImproveThis } from './NextStepsImproveThis'
import { NextStepsAnswerBar } from './NextStepsAnswerBar'
import { nextStepsAnswerOf } from './next-steps-answer'
import {
  NextStepsFailureLine,
  NextStepsThinkingLine,
  NextStepsTrayPanel,
  type NextStepsTrayActions
} from './NextStepsTrayPanel'
import {
  useNextStepsTray,
  type NextStepsNotice,
  type NextStepsTrayInput,
  type NextStepsTrayState
} from './use-next-steps-tray'

export type NextStepsTrayProps = NextStepsTrayInput & {
  /** Inside a popover the tray drops its page margins. */
  compact?: boolean
}

function notQueuedLine(
  chosen: readonly NextStepSuggestion[],
  notQueued: readonly { id: string; reason: string }[]
): string {
  const titles = notQueued.map(
    (entry) => chosen.find((suggestion) => suggestion.id === entry.id)?.title ?? entry.id
  )
  const reasons = [...new Set(notQueued.map((entry) => entry.reason))].join(' ')
  return translate('nextSteps.notQueued', 'Not queued: {{titles}}. {{reason}}', {
    titles: titles.join('; '),
    reason: reasons
  }).trim()
}

/** What the host said beyond "done": nothing queued, or a decision the log could not keep. */
function decideNotice(
  result: NextStepsDecideResult,
  chosen: readonly NextStepSuggestion[]
): NextStepsNotice | null {
  if (result.notQueued.length) {
    return {
      tone: 'error',
      lines: [
        notQueuedLine(chosen, result.notQueued),
        ...(result.logError ? [result.logError] : [])
      ]
    }
  }
  return result.logError ? { tone: 'warning', lines: [result.logError] } : null
}

function trayActions(tray: NextStepsTrayState): NextStepsTrayActions {
  return {
    run: async (set, chosen) => {
      const result = await tray.decide(set, {
        action: 'run',
        suggestionIds: chosen.map((suggestion) => suggestion.id)
      })
      if (result) {
        tray.setNotice(decideNotice(result, chosen))
      }
    },
    save: async (set, chosen) => {
      if (!tray.conversation) {
        return
      }
      const result = await saveNextStepsForLater({
        conversation: tray.conversation,
        sessionLabel: tray.sessionLabel,
        setId: set.id,
        suggestions: chosen
      })
      if ('refusal' in result) {
        tray.setNotice({ tone: 'error', lines: [result.refusal] })
        return
      }
      const lines = result.cards.map((card) =>
        card.ok
          ? [
              translate('nextSteps.savedCard', 'Saved “{{title}}” as a Proposed card.', {
                title: card.title
              }),
              card.warning ?? ''
            ]
              .join(' ')
              .trim()
          : translate('nextSteps.saveFailed', '“{{title}}” was not saved: {{message}}', {
              title: card.title,
              message: card.message
            })
      )
      const saved = result.cards.filter((card) => card.ok).map((card) => card.suggestionId)
      let tone: NextStepsNotice['tone'] = saved.length === result.cards.length ? 'info' : 'error'
      if (saved.length) {
        try {
          const decided = await tray.decide(set, { action: 'save', suggestionIds: saved })
          // The cards exist either way; anything the host did not take is a warning.
          const refused = decided
            ? decideNotice(decided, chosen)?.lines
            : [
                translate(
                  'nextSteps.saveAnswerPending',
                  'Another answer to these suggestions is still being recorded.'
                )
              ]
          if (refused?.length) {
            lines.push(...refused)
            tone = tone === 'error' ? tone : 'warning'
          }
        } catch (failure) {
          // The cards exist; only the answer is missing. Saving again files nothing twice.
          lines.push(
            translate(
              'nextSteps.saveNotRecorded',
              'The cards were filed, but the save was not recorded: {{reason}} Save again to retry.',
              { reason: failure instanceof Error ? failure.message : String(failure) }
            )
          )
          tone = tone === 'error' ? tone : 'warning'
        }
      }
      tray.setNotice({ tone, lines })
    },
    dismiss: async (set: NextStepSuggestionSet) => {
      const result = await tray.decide(set, { action: 'dismiss' })
      if (result) {
        tray.setNotice(decideNotice(result, []))
      }
    },
    suggest: tray.suggest
  }
}

/**
 * Any answer the person gives clears the last "Keep going" stop line, and an answer to a set
 * (run, save, dismiss) stops Keep going on the host before the answer's own work starts.
 */
function acknowledgingKeepGoing(
  actions: NextStepsTrayActions,
  conversation: ConversationSource
): NextStepsTrayActions {
  const acknowledged =
    <A extends unknown[]>(act: (...args: A) => Promise<void>, stopsKeepGoing: boolean) =>
    (...args: A): Promise<void> => {
      const stopping = stopsKeepGoing ? stopKeepGoingForPersonAction(conversation) : null
      const acted = stopping ? stopping.then(() => act(...args)) : act(...args)
      // Only once the host has taken the answer.
      return acted.then(() => acknowledgeNextStepKeepGoingStop(conversation))
    }
  return {
    run: acknowledged(actions.run, true),
    save: acknowledged(actions.save, true),
    dismiss: acknowledged(actions.dismiss, true),
    suggest: acknowledged(actions.suggest, false)
  }
}

function NoticeLines({ notice, onClose }: { notice: NextStepsNotice; onClose?: () => void }) {
  return (
    <div className="flex items-start gap-2 px-3 py-1">
      <ul
        role={notice.tone === 'info' ? 'status' : 'alert'}
        className={cn(
          'min-w-0 flex-1 text-xs',
          notice.tone === 'error' && 'text-destructive',
          notice.tone === 'warning' && 'text-status-warning',
          notice.tone === 'info' && 'text-muted-foreground'
        )}
      >
        {[...new Set(notice.lines)].map((line) => (
          <li key={line} className="break-words">
            {line}
          </li>
        ))}
      </ul>
      {onClose ? (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={translate('nextSteps.closeNotice', 'Close')}
          onClick={onClose}
        >
          <X />
        </Button>
      ) : null}
    </div>
  )
}

/**
 * Suggested next steps for the conversation's latest turn: the reply's own proposals first, the
 * AI's set when the reply proposed none, and the AI's extra ideas below them when asked for. Nothing runs without a click, and every click is
 * answered by the host, which queues the chosen prompts through the prompt queue.
 */
export function NextStepsTray({ compact = false, ...input }: NextStepsTrayProps) {
  const tray = useNextStepsTray(input)
  if (!tray.conversation) {
    return null
  }
  const sectionClass = cn('w-full shrink-0', compact ? 'p-0' : 'mx-auto max-w-4xl px-4')
  // Keep going's line outlives the rest of the tray: it runs while the agent works.
  const keepGoingOnly = (
    <NextStepsKeepGoingStatus conversation={tray.conversation} className={sectionClass} />
  )
  if (input.disabled || tray.reply === null) {
    return keepGoingOnly
  }
  const { view, notice, problem } = tray
  const problemLine = problem ? (
    <p className="truncate px-3 py-1 text-xs text-muted-foreground" title={problem}>
      {problem}
    </p>
  ) : null
  const actions = acknowledgingKeepGoing(trayActions(tray), tray.conversation)
  const closeNotice = () => tray.setNotice(null)
  const onError = (message: string) => tray.setNotice({ tone: 'error', lines: [message] })
  const { conversation } = tray
  const onTick = (): void => {
    stopKeepGoingForPersonAction(conversation).catch((failure: unknown) =>
      onError(failure instanceof Error ? failure.message : String(failure))
    )
  }
  const improve = (className?: string) => (
    <NextStepsImproveThis
      conversation={conversation}
      messages={input.messages}
      className={className}
    />
  )
  let body: React.ReactNode
  // The session asked: its proposal is answered with one click, above the checklist; a menu it
  // offered is the checklist itself, its named options ticked, built with one click.
  const answer = nextStepsAnswerOf(view.shown?.set)
  if (view.shown) {
    const shownSet = view.shown.set
    body = (
      <>
        {answer && answer.kind !== 'choose' ? (
          <NextStepsAnswerBar
            className="border-b border-status-info-border px-3 py-2"
            answer={answer}
            onError={onError}
            actions={{
              run: (step) => actions.run(shownSet, [step]),
              no: () => actions.dismiss(shownSet)
            }}
          />
        ) : null}
        <NextStepsTrayPanel
          key={view.shown.set.id}
          set={view.shown.set}
          suggestions={view.shown.suggestions}
          thinking={view.thinking}
          failure={view.failure}
          suggesting={tray.suggesting}
          actions={actions}
          onError={onError}
          headerControl={<NextStepsKeepGoingControl conversation={tray.conversation} />}
          doneness={tray.doneness}
          onTick={onTick}
          {...(answer?.kind === 'choose' ? { choose: answer } : {})}
        />
        {view.extra ? (
          <div className="border-t border-status-info-border">
            <NextStepsTrayPanel
              key={view.extra.set.id}
              set={view.extra.set}
              suggestions={view.extra.suggestions}
              thinking={false}
              failure={null}
              suggesting={tray.suggesting}
              actions={actions}
              onError={onError}
              title={translate('nextSteps.moreFromAi', 'More ideas from the AI')}
              onTick={onTick}
            />
          </div>
        ) : null}
        {improve('flex px-3 pb-1')}
        {notice ? <NoticeLines notice={notice} /> : null}
        {problemLine}
      </>
    )
  } else if (view.answered || (tray.reply === undefined && !view.thinking)) {
    if (!notice && !problemLine) {
      return keepGoingOnly
    }
    body = (
      <>
        {notice ? <NoticeLines notice={notice} onClose={closeNotice} /> : null}
        {problemLine}
      </>
    )
  } else {
    body = (
      <>
        <div className="flex items-center gap-2 px-3 py-1.5">
          {view.thinking ? (
            <NextStepsThinkingLine />
          ) : (
            <>
              {view.failure !== null ? <NextStepsFailureLine reason={view.failure} /> : null}
              <Button
                size="xs"
                variant="ghost"
                className="text-muted-foreground"
                disabled={tray.suggesting}
                onClick={() => void actions.suggest()}
              >
                {translate('nextSteps.suggest', 'Suggest next steps')}
              </Button>
              {improve()}
            </>
          )}
        </div>
        {notice ? <NoticeLines notice={notice} onClose={closeNotice} /> : null}
        {problemLine}
      </>
    )
  }
  const framed = Boolean(view.shown) || Boolean(notice)
  return (
    <section
      className={cn('w-full shrink-0', compact ? 'p-0' : 'mx-auto max-w-4xl px-4 py-2')}
      aria-label={translate('nextSteps.title', 'Suggested next steps')}
      data-next-steps-tray
    >
      <NextStepsKeepGoingStatus conversation={tray.conversation} />
      <div
        className={cn(
          framed && 'rounded-md border border-status-info-border bg-status-info-background'
        )}
      >
        {body}
      </div>
    </section>
  )
}
