import { translate } from '@/i18n/i18n'
import { nextStepDonePercent, type NextStepDoneness } from '../../../../shared/next-step-doneness'

const percent = (value: number): number => Math.round(value * 100)

/** JEV's readings in words, for the chip's hover. */
export function nextStepsDonenessDetail(reading: NextStepDoneness): string {
  return translate(
    'nextSteps.doneness.detail',
    'resolved {{resolved}}% · still missing {{missing}}% · room to improve {{room}}% · checked {{checked}}% (JEV, advisory)',
    {
      resolved: percent(reading.resolved),
      missing: percent(reading.remainingWork),
      room: percent(reading.roomToImprove),
      checked: percent(reading.verified)
    }
  )
}

/** "≈ 85% done" beside the tray's heading; nothing unless JEV's `resolved` reading is clear. */
export function NextStepsDonenessChip({
  reading
}: {
  reading: NextStepDoneness | null | undefined
}) {
  const done = nextStepDonePercent(reading)
  if (!reading || done === null) {
    return null
  }
  const detail = nextStepsDonenessDetail(reading)
  return (
    <span
      className="rounded-full border border-border px-1.5 font-normal text-muted-foreground tabular-nums"
      title={detail}
      aria-label={detail}
      data-next-steps-doneness
    >
      {translate('nextSteps.doneness.chip', '≈ {{percent}}% done', { percent: done })}
    </span>
  )
}
