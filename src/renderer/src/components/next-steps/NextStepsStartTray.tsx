import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { ConversationSource } from '../../../../shared/conversation-source'
import type { NextStepSuggestion } from '../../../../shared/next-step-suggestions'
import { saveNextStepsForLater } from './next-steps-save-for-later'
import { nextStepsStartView } from './next-steps-start-model'
import { NextStepsTrayPanel, type NextStepsTrayActions } from './NextStepsTrayPanel'
import { useNextStepsStart, type NextStepsStartState } from './use-next-steps-start'

export type NextStepsStartTrayProps = {
  worktreeId: string
  paneKey: string
  tabId: string
  agent?: string
  conversation?: ConversationSource | null
  /** On screen, and the conversation still has no message. */
  active: boolean
  /** Inside a popover the tray drops its page margins. */
  compact?: boolean
}

function waitingLine(): string {
  return translate(
    'nextStepsStart.noConversation',
    'This conversation is still starting. Try again in a moment.'
  )
}

function titled(chosen: readonly NextStepSuggestion[], id: string): string {
  return chosen.find((suggestion) => suggestion.id === id)?.title ?? id
}

function startActions(start: NextStepsStartState): NextStepsTrayActions {
  return {
    // The host queues the chosen prompts in the set's order: the first becomes this
    // conversation's first message, each later one waits until the agent is free again.
    run: async (set, chosen) => {
      const result = await start.decide(set, {
        action: 'run',
        suggestionIds: chosen.map((suggestion) => suggestion.id)
      })
      start.setNotice(
        result.notQueued.length
          ? {
              tone: 'error',
              lines: result.notQueued.map((entry) =>
                translate('nextSteps.notQueued', 'Not queued: {{titles}}. {{reason}}', {
                  titles: titled(chosen, entry.id),
                  reason: entry.reason
                })
              )
            }
          : null
      )
    },
    save: async (set, chosen) => {
      if (!start.conversation) {
        start.setNotice({ tone: 'info', lines: [waitingLine()] })
        return
      }
      const result = await saveNextStepsForLater({
        conversation: start.conversation,
        sessionLabel: start.sessionLabel,
        setId: set.id,
        suggestions: chosen
      })
      if ('refusal' in result) {
        start.setNotice({ tone: 'error', lines: [result.refusal] })
        return
      }
      const saved = result.cards.filter((card) => card.ok).map((card) => card.suggestionId)
      const lines = result.cards.map((card) =>
        card.ok
          ? translate('nextSteps.savedCard', 'Saved “{{title}}” as a Proposed card.', {
              title: card.title
            })
          : translate('nextSteps.saveFailed', '“{{title}}” was not saved: {{message}}', {
              title: card.title,
              message: card.message
            })
      )
      if (saved.length) {
        await start.decide(set, { action: 'save', suggestionIds: saved })
      }
      start.setNotice({ tone: saved.length === result.cards.length ? 'info' : 'error', lines })
    },
    dismiss: async (set) => {
      await start.decide(set, { action: 'dismiss' })
      start.setNotice(null)
    },
    suggest: start.suggest
  }
}

/**
 * "Suggested starts" for a conversation with no message yet: carry-over from the last session in
 * this workspace at once, the suggester's first steps when they are written. Nothing is sent
 * until the person clicks; dismissing hides the set for this workspace for the hour.
 */
export function NextStepsStartTray({ compact = false, ...input }: NextStepsStartTrayProps) {
  const start = useNextStepsStart(input)
  const view = nextStepsStartView(start.set)
  const quiet = start.skipped ?? (view.shown.length ? null : view.failure)
  const idle = start.answered && !view.shown.length && !start.requesting
  // A failed or skipped ask says why, quietly; an empty popover (the pill was clicked) says so too.
  const notice =
    start.notice ??
    (idle && quiet !== null
      ? {
          tone: 'info' as const,
          lines: [
            quiet || translate('nextSteps.failedNoReason', 'Suggestions could not be generated.')
          ]
        }
      : idle && compact
        ? {
            tone: 'info' as const,
            lines: [translate('nextStepsStart.none', 'No suggested starts right now.')]
          }
        : view.shown.length && !start.conversation
          ? { tone: 'info' as const, lines: [waitingLine()] }
          : null)
  if (!start.active || (!view.shown.length && !notice)) {
    return null
  }
  return (
    <section
      className={cn('w-full shrink-0', compact ? 'p-0' : 'mx-auto max-w-4xl px-4 py-2')}
      aria-label={translate('nextStepsStart.title', 'Suggested starts')}
      data-next-steps-start
    >
      <div className="rounded-md border border-status-info-border bg-status-info-background">
        {start.set && view.shown.length ? (
          <NextStepsTrayPanel
            key={start.set.id}
            set={start.set}
            suggestions={view.shown}
            thinking={view.thinking}
            failure={view.failure}
            // Why: nothing is answerable until the runtime names the real conversation.
            suggesting={start.requesting || view.thinking || !start.conversation}
            actions={startActions(start)}
            onError={(message) => start.setNotice({ tone: 'error', lines: [message] })}
            title={translate('nextStepsStart.title', 'Suggested starts')}
          />
        ) : null}
        {notice ? (
          <ul
            role={notice.tone === 'error' ? 'alert' : 'status'}
            className={cn(
              'px-3 py-1 text-xs',
              notice.tone === 'error' ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            {[...new Set(notice.lines)].map((line) => (
              <li key={line} className="break-words">
                {line}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  )
}
