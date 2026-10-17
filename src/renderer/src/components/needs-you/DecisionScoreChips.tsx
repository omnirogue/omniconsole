import React from 'react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { scoreBand, type DecisionScores } from '../../../../shared/session-decisions'

const percent = (value: number): string => `${Math.round(value * 100)}%`

function Chip({
  label,
  value,
  tone,
  title
}: {
  label: string
  value: string
  tone: 'neutral' | 'warning' | 'danger' | 'strong'
  title: string
}): React.JSX.Element {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] tabular-nums',
        tone === 'danger' && 'border-destructive/40 text-destructive',
        tone === 'warning' &&
          'border-status-warning-border bg-status-warning-background text-status-warning',
        tone === 'strong' && 'border-border font-semibold text-foreground',
        tone === 'neutral' && 'border-border text-muted-foreground'
      )}
    >
      <span>{label}</span>
      <span>{value}</span>
    </span>
  )
}

/**
 * JEV's Impact / Risk / Effort reading, 0–100%. Risk is colored by concern; impact is bold when
 * high. A missing reading says why instead of guessing a number.
 */
export function DecisionScoreChips({
  scores,
  unavailable
}: {
  scores: DecisionScores | null
  unavailable: string | null
}): React.JSX.Element {
  const source = translate('decisions.jevSource', 'JEV reading (advice, not a decision)')
  if (!scores) {
    return (
      <span
        className="inline-flex items-center rounded-md border border-dashed px-1.5 py-0.5 text-[11px] text-muted-foreground"
        title={unavailable ?? source}
        data-decision-scores="pending"
      >
        {unavailable
          ? translate('decisions.notScored', 'Not scored')
          : translate('decisions.scoring', 'Scoring…')}
      </span>
    )
  }
  const risk = scoreBand(scores.risk)
  const impact = scoreBand(scores.impact)
  return (
    <span className="inline-flex flex-wrap gap-1" data-decision-scores="ready">
      <Chip
        label={translate('decisions.impact', 'Impact')}
        value={percent(scores.impact)}
        tone={impact === 'high' ? 'strong' : 'neutral'}
        title={translate(
          'decisions.impactHint',
          'JEV reading (advice, not a decision): how much the answer changes outcomes'
        )}
      />
      <Chip
        label={translate('decisions.risk', 'Risk')}
        value={percent(scores.risk)}
        tone={risk === 'high' ? 'danger' : risk === 'medium' ? 'warning' : 'neutral'}
        title={translate(
          'decisions.riskHint',
          'JEV reading (advice, not a decision): how bad and how hard to undo a wrong answer is'
        )}
      />
      <Chip
        label={translate('decisions.effort', 'Effort')}
        value={percent(scores.effort)}
        tone="neutral"
        title={translate(
          'decisions.effortHint',
          'JEV reading (advice, not a decision): how much attention deciding it well takes'
        )}
      />
    </span>
  )
}
