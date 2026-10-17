import { translate } from '@/i18n/i18n'

/**
 * There is no pre-launch arm: the first prompt is the launch, and every follow-up belongs to
 * the launched conversation's Up next. This line says so where the arm control used to be.
 */
export function AttentionNextStepArm(): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-1" data-attention-next-step-arm>
      <span className="text-xs text-muted-foreground">
        {translate(
          'upNext.launchFollowups',
          'Add follow-ups from the launched conversation’s Up next.'
        )}
      </span>
    </div>
  )
}
