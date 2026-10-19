import React, { useState } from 'react'
import { AlertTriangle, ShieldAlert, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import {
  buildOmniRogueSpendGuardCopy,
  mergeOmniRogueSpendGuardLabels,
  omniRogueSpendGuardDismissKey,
  pickOmniRogueSpendGuard,
  type OmniRogueSpendGuardLabels,
  type OmniRogueSpendGuardLimit,
  type OmniRogueSpendGuardState
} from './omnirogue-spend-guard-helpers'

export type OmniRogueSpendGuardBannerProps = {
  /** Every active cap; the banner shows the most severe one. */
  limits: readonly OmniRogueSpendGuardLimit[] | null | undefined
  labels?: Partial<OmniRogueSpendGuardLabels>
  onRaiseLimit?: (state: OmniRogueSpendGuardState) => void
  onReviewUsage?: (state: OmniRogueSpendGuardState) => void
  onDismiss?: (state: OmniRogueSpendGuardState) => void
  /** Hides the dismiss control; a reached limit is never dismissible. */
  dismissible?: boolean
  locale?: string
  now?: () => Date
  className?: string
}

function defaultNow(): Date {
  return new Date()
}

const TONE_CLASSES = {
  warning: {
    container: 'border-status-warning-border bg-status-warning-background text-status-warning',
    progress: 'bg-status-warning/20 [&_[data-slot=progress-indicator]]:bg-status-warning',
    action: 'border-status-warning-border text-status-warning hover:bg-status-warning-background'
  },
  reached: {
    container: 'border-destructive/40 bg-destructive/10 text-destructive',
    progress: 'bg-destructive/20 [&_[data-slot=progress-indicator]]:bg-destructive',
    action: 'border-destructive/40 text-destructive hover:bg-destructive/15'
  }
} as const

function SpendGuardActions({
  state,
  labels,
  actionClassName,
  onRaiseLimit,
  onReviewUsage
}: {
  state: OmniRogueSpendGuardState
  labels: OmniRogueSpendGuardLabels
  actionClassName: string
  onRaiseLimit?: (state: OmniRogueSpendGuardState) => void
  onReviewUsage?: (state: OmniRogueSpendGuardState) => void
}): React.ReactElement | null {
  if (!onRaiseLimit && !onReviewUsage) {
    return null
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1">
      {onReviewUsage ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          data-testid="omnirogue-spend-guard-review"
          className="h-6 px-2 text-[11px]"
          onClick={() => onReviewUsage(state)}
        >
          {labels.reviewUsageAction}
        </Button>
      ) : null}
      {onRaiseLimit ? (
        <Button
          type="button"
          size="xs"
          variant="outline"
          data-testid="omnirogue-spend-guard-raise"
          className={cn('h-6 bg-transparent px-2 text-[11px]', actionClassName)}
          onClick={() => onRaiseLimit(state)}
        >
          {labels.raiseLimitAction}
        </Button>
      ) : null}
    </div>
  )
}

export function OmniRogueSpendGuardBanner({
  limits,
  labels: labelOverrides,
  onRaiseLimit,
  onReviewUsage,
  onDismiss,
  dismissible = true,
  locale,
  now = defaultNow,
  className
}: OmniRogueSpendGuardBannerProps): React.ReactElement | null {
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  const state = pickOmniRogueSpendGuard(limits)

  if (!state || state.level === 'ok') {
    return null
  }
  const dismissKey = omniRogueSpendGuardDismissKey(state)
  if (dismissedKey === dismissKey) {
    return null
  }

  const labels = mergeOmniRogueSpendGuardLabels(labelOverrides)
  const copy = buildOmniRogueSpendGuardCopy(state, labels, now(), locale)
  const reached = state.level === 'reached'
  const tone = TONE_CLASSES[state.level]
  const Icon = reached ? ShieldAlert : AlertTriangle
  // Reached stays up: the guard is actively holding spend, so hiding it would hide the cause.
  const canDismiss = dismissible && !reached

  return (
    <div
      role={reached ? 'alert' : 'status'}
      data-testid="omnirogue-spend-guard-banner"
      data-level={state.level}
      data-period={state.period}
      className={cn(
        'flex items-start gap-2 rounded-md border p-2.5 text-[11px]',
        tone.container,
        className
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <p data-testid="omnirogue-spend-guard-heading" className="font-semibold">
          {copy.heading}
        </p>
        <p data-testid="omnirogue-spend-guard-body" className="leading-relaxed">
          {copy.body}
        </p>
        <Progress
          value={Math.min(100, Math.max(0, state.usedRatio * 100))}
          aria-label={copy.progressAriaLabel}
          data-testid="omnirogue-spend-guard-progress"
          className={cn('h-1.5', tone.progress)}
        />
        {copy.resetNote ? (
          <p data-testid="omnirogue-spend-guard-reset" className="opacity-80">
            {copy.resetNote}
          </p>
        ) : null}
        <SpendGuardActions
          state={state}
          labels={labels}
          actionClassName={tone.action}
          onRaiseLimit={onRaiseLimit}
          onReviewUsage={onReviewUsage}
        />
      </div>
      {canDismiss ? (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          data-testid="omnirogue-spend-guard-dismiss"
          aria-label={labels.dismissAction}
          className="shrink-0 text-current hover:bg-transparent hover:opacity-80"
          onClick={() => {
            setDismissedKey(dismissKey)
            onDismiss?.(state)
          }}
        >
          <X aria-hidden />
        </Button>
      ) : null}
    </div>
  )
}
