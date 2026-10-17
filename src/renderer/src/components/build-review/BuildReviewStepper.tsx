import { Check, X } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type {
  BuildReviewStep,
  BuildReviewStepId,
  BuildReviewStepState
} from './build-review-progress'

function stepLabel(id: BuildReviewStepId): string {
  switch (id) {
    case 'build':
      return translate('buildReview.step.build', 'Build')
    case 'review':
      return translate('buildReview.step.review', 'Review')
    case 'fix':
      return translate('buildReview.step.fix', 'Fix')
  }
}

function stepStateLabel(state: BuildReviewStepState): string {
  switch (state) {
    case 'upcoming':
      return translate('buildReview.step.upcoming', 'Not started')
    case 'active':
      return translate('buildReview.step.active', 'In progress')
    case 'done':
      return translate('buildReview.step.done', 'Done')
    case 'failed':
      return translate('buildReview.step.failed', 'Stopped here')
    case 'cancelled':
      return translate('buildReview.step.cancelled', 'Cancelled')
    case 'skipped':
      return translate('buildReview.step.skipped', 'Not needed')
    case 'round-limit':
      return translate('buildReview.step.roundLimit', 'Round limit reached')
  }
}

function StepMark({ state, number }: { state: BuildReviewStepState; number: number }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-border bg-background text-[11px] font-semibold leading-none text-muted-foreground',
        state === 'active' &&
          'border-status-info bg-status-info text-background motion-safe:animate-pulse',
        state === 'done' &&
          'border-status-success bg-status-success-background text-status-success',
        state === 'failed' && 'border-destructive bg-destructive/10 text-destructive',
        state === 'skipped' && 'border-dashed',
        state === 'round-limit' && 'border-status-warning text-status-warning'
      )}
    >
      {state === 'done' ? (
        <Check className="size-3" />
      ) : state === 'failed' || state === 'cancelled' ? (
        <X className="size-3" />
      ) : (
        number
      )}
    </span>
  )
}

/** Build → Review → Fix, left to right, with the step the run is on (or stopped at) marked. */
export function BuildReviewStepper({ steps }: { steps: readonly BuildReviewStep[] }) {
  return (
    <ol
      className="flex min-w-0 items-center gap-2"
      aria-label={translate('buildReview.step.label', 'Progress')}
    >
      {steps.map((step, index) => (
        <li
          key={step.id}
          className="flex min-w-0 items-center gap-2"
          aria-current={step.state === 'active' ? 'step' : undefined}
          data-build-review-step={step.id}
          data-state={step.state}
        >
          {index > 0 && (
            <span
              aria-hidden="true"
              className={cn(
                'h-0.5 w-6 shrink-0 rounded-full bg-border sm:w-10',
                (step.state === 'done' || step.state === 'active') && 'bg-muted-foreground/40'
              )}
            />
          )}
          <StepMark state={step.state} number={index + 1} />
          <span
            className={cn(
              'text-xs',
              step.state === 'active' ? 'font-medium text-foreground' : 'text-muted-foreground'
            )}
          >
            {stepLabel(step.id)}
            <span className="sr-only">{` · ${stepStateLabel(step.state)}`}</span>
          </span>
        </li>
      ))}
    </ol>
  )
}
