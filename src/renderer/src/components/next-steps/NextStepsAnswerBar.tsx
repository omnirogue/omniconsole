import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { NextStepSuggestion } from '../../../../shared/next-step-suggestions'
import type { NextStepsButtonAnswer } from './next-steps-answer'

export type NextStepsAnswerActions = {
  /** Sends the session's own proposal as the person's answer; a throw is shown by the caller. */
  run: (step: NextStepSuggestion) => Promise<void>
  /** Dismisses the proposal: nothing is sent. */
  no: () => Promise<void>
}

/**
 * The person's one-click answer to a session that asked: "Yes" for one proposal, one button per
 * offered option. The risk label never gates it: the click is the person's explicit answer.
 */
export function NextStepsAnswerBar({
  answer,
  actions,
  onError,
  compact = false,
  className
}: {
  answer: NextStepsButtonAnswer
  actions: NextStepsAnswerActions
  onError: (message: string) => void
  /** The terminal pill: the step reads inside the button itself. */
  compact?: boolean
  className?: string
}) {
  const [busy, setBusy] = useState(false)
  // Why a ref: two clicks in one frame both see the state from before the first one.
  const inFlight = useRef(false)
  const act = (work: () => Promise<void>) => {
    if (inFlight.current) {
      return
    }
    inFlight.current = true
    setBusy(true)
    work()
      .catch((failure: unknown) =>
        onError(failure instanceof Error ? failure.message : String(failure))
      )
      .finally(() => {
        inFlight.current = false
        setBusy(false)
      })
  }
  const yesLabel = (step: NextStepSuggestion) =>
    translate('nextSteps.answer.yesLabel', 'Yes: {{title}}', { title: step.title })
  return (
    <div
      className={cn('flex min-w-0 items-center gap-1.5', className)}
      data-next-steps-answer={answer.kind}
    >
      {answer.kind === 'yes' ? (
        <>
          <Button
            size="xs"
            className={cn('min-w-0 shrink', compact && 'max-w-72')}
            disabled={busy}
            aria-label={yesLabel(answer.step)}
            title={answer.step.title}
            onClick={() => act(() => actions.run(answer.step))}
          >
            {compact ? (
              <span className="truncate">
                {translate('nextSteps.answer.yesStep', 'Yes · {{title}}', {
                  title: answer.step.title
                })}
              </span>
            ) : (
              translate('nextSteps.answer.yes', 'Yes')
            )}
          </Button>
          {compact ? null : (
            <span className="min-w-0 truncate text-xs" title={answer.step.title}>
              {answer.step.title}
            </span>
          )}
        </>
      ) : (
        answer.steps.map((step, index) => (
          <Button
            key={step.id}
            size="xs"
            variant={index === 0 ? 'default' : 'secondary'}
            className="min-w-0 max-w-48 shrink"
            disabled={busy}
            aria-label={yesLabel(step)}
            title={step.title}
            onClick={() => act(() => actions.run(step))}
          >
            <span className="truncate">{step.title}</span>
          </Button>
        ))
      )}
      <Button
        size="xs"
        variant="ghost"
        className="shrink-0"
        disabled={busy}
        aria-label={translate('nextSteps.answer.noLabel', 'No, send nothing')}
        onClick={() => act(actions.no)}
      >
        {translate('nextSteps.answer.no', 'No')}
      </Button>
    </div>
  )
}
