import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { ConversationSource } from '../../../../shared/conversation-source'
import type {
  NextStepDecision,
  NextStepSuggestionSet
} from '../../../../shared/next-step-suggestions'
import { NextStepsAnswerBar } from './NextStepsAnswerBar'
import { stopKeepGoingForPersonAction } from './NextStepsKeepGoing'
import { NextStepsRetryPill } from './NextStepsRetryPill'
import { NextStepsStartPill } from './NextStepsStartPill'
import { NextStepsTerminalChecklist } from './NextStepsTerminalChecklist'
import { NextStepsTray } from './NextStepsTray'
import { nextStepsAnswerOf } from './next-steps-answer'
import { decideNextStepSet } from './next-steps-client'
import {
  acknowledgeNextStepKeepGoingStop,
  refreshPendingNextSteps,
  useNextStepKeepGoingRunning,
  usePendingNextStepCount,
  usePendingNextStepSet
} from './next-steps-pending-store'

/** Small pulse beside the pill or badge while "Keep going" runs the conversation. */
export function KeepGoingDot() {
  return (
    <span
      className="inline-block size-1.5 shrink-0 animate-pulse rounded-full bg-status-info"
      aria-hidden
    />
  )
}

/** The person's answer from the pill: Keep going stops on the host first, as for any answer. */
async function answerFromPill(
  conversation: ConversationSource,
  set: NextStepSuggestionSet,
  decision: NextStepDecision
): Promise<void> {
  await stopKeepGoingForPersonAction(conversation)
  try {
    const result = await decideNextStepSet(set.id, decision)
    if (result.notQueued.length) {
      throw new Error(result.notQueued.map((entry) => entry.reason).join(' '))
    }
    acknowledgeNextStepKeepGoingStop(conversation)
  } finally {
    refreshPendingNextSteps()
  }
}

/**
 * A conversation shown as its terminal still has suggested next steps: a small pill in the
 * pane's top-right corner opens the same tray the chat view shows. When the session asked the
 * person something, the pill IS the answer: "Yes · <step>" sends it in one click, no popover. A
 * menu the session offered opens as a checklist card instead, until the person collapses it; the
 * next menu opens again. A turn whose suggestions failed shows a quiet Retry.
 * Top, not bottom: an agent's input box, status line and permission prompts all live at the
 * bottom, and the pane header and terminal search above it keep the first 44px.
 */
export function NextStepsTerminalPill({
  worktreeId,
  tabId,
  paneKey,
  suppressed = false
}: {
  worktreeId: string
  tabId: string
  paneKey: string
  /** An open agent question owns the corner; state is kept for when it closes. */
  suppressed?: boolean
}) {
  const conversation = useMemo<ConversationSource>(
    () => ({ worktreeId, paneKey, kind: 'pty' }),
    [worktreeId, paneKey]
  )
  const count = usePendingNextStepCount(conversation)
  const running = useNextStepKeepGoingRunning(conversation)
  const answer = nextStepsAnswerOf(usePendingNextStepSet(conversation))
  const turnFinished = useAppStore((state) => state.agentStatusByPaneKey[paneKey]?.state === 'done')
  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  // The menu the person collapsed; a new set is a new menu and opens again.
  const [collapsedSetId, setCollapsedSetId] = useState<string | null>(null)
  if (suppressed) {
    return null
  }
  if (!count && !running && !open) {
    return (
      <NextStepsRetryPill
        conversation={conversation}
        active={count === 0 && turnFinished}
        fallback={<NextStepsStartPill worktreeId={worktreeId} tabId={tabId} paneKey={paneKey} />}
      />
    )
  }
  const choose = answer?.kind === 'choose' ? answer : null
  const buttons = answer && answer.kind !== 'choose' ? answer : null
  if (choose && collapsedSetId !== choose.set.id && !open) {
    return (
      <div
        // Why max-h-[50%]: the agent's own input and prompts keep the bottom half of the pane.
        className="pointer-events-none absolute top-11 right-3 z-10 flex max-h-[50%] max-w-[calc(100%-1.5rem)] flex-col items-end"
        data-next-steps-pill={paneKey}
      >
        <NextStepsTerminalChecklist
          tabId={tabId}
          paneKey={paneKey}
          conversation={conversation}
          count={choose.steps.length}
          onCollapse={() => setCollapsedSetId(choose.set.id)}
        />
      </div>
    )
  }
  const trigger = choose ? (
    <Button
      size="xs"
      variant="secondary"
      className="pointer-events-auto shrink-0 rounded-full border border-status-info-border shadow-xs"
      aria-label={translate('nextSteps.checklist.expand', 'Show the options')}
      onClick={() => setCollapsedSetId(null)}
    >
      {running ? <KeepGoingDot /> : null}
      {translate('nextSteps.pill', '✦ {{n}} next steps', { n: count ?? choose.steps.length })}
    </Button>
  ) : (
    <PopoverTrigger asChild>
      <Button
        size="xs"
        variant="secondary"
        className="pointer-events-auto shrink-0 rounded-full border border-status-info-border shadow-xs"
        aria-label={
          buttons ? translate('nextSteps.answer.openTray', 'Show all next steps') : undefined
        }
        data-next-steps-keep-going={running || undefined}
      >
        {running ? <KeepGoingDot /> : null}
        {buttons
          ? '✦'
          : count
            ? translate('nextSteps.pill', '✦ {{n}} next steps', { n: count })
            : running
              ? translate('nextSteps.keepGoing.pill', 'Keep going')
              : translate('nextSteps.pillEmpty', '✦ Next steps')}
      </Button>
    </PopoverTrigger>
  )
  return (
    <div
      // Why pointer-events-none: only the pill itself takes clicks, never the terminal around it.
      className="pointer-events-none absolute top-11 right-3 z-10 flex max-w-[70%] flex-col items-end gap-1"
      data-next-steps-pill={paneKey}
    >
      <Popover open={open} onOpenChange={setOpen}>
        {buttons ? (
          <div className="pointer-events-auto flex min-w-0 items-center gap-1 rounded-full border border-status-info-border bg-status-info-background py-0.5 pr-0.5 pl-1 shadow-xs">
            <NextStepsAnswerBar
              compact
              answer={buttons}
              onError={setFailure}
              actions={{
                run: (step) => {
                  setFailure(null)
                  return answerFromPill(conversation, buttons.set, {
                    action: 'run',
                    suggestionIds: [step.id]
                  })
                },
                no: () => {
                  setFailure(null)
                  return answerFromPill(conversation, buttons.set, { action: 'dismiss' })
                }
              }}
            />
            {trigger}
          </div>
        ) : (
          trigger
        )}
        <PopoverContent side="bottom" align="end" className="w-[28rem] max-w-[90vw] p-0">
          <NextStepsTray
            compact
            paneKey={paneKey}
            tabId={tabId}
            conversation={conversation}
            disabled={false}
          />
        </PopoverContent>
      </Popover>
      {failure ? (
        <p
          role="alert"
          className="pointer-events-auto max-w-full truncate rounded-sm bg-background px-2 py-0.5 text-xs text-destructive"
          title={failure}
        >
          {failure}
        </p>
      ) : null}
    </div>
  )
}
