import { translate } from '@/i18n/i18n'
import { workPlanNotation, workPlanSummary } from '../../../../../shared/work-plan-notation'
import { workPlanSentence } from '../../../../../shared/work-plan-sentence'
import type { WorkPlan } from '../../../../../shared/work-plan-types'

export type WorkPlanComposerSummaryProps = {
  plan: WorkPlan
  capacity: number
  /** Stage rows drawn beneath, so the header can never claim a chain the list does not show. */
  stageCount: number
  runnable: boolean
}

/**
 * The chain, the counts and the sentence are three renderings of ONE plan object, computed on
 * every render from the plan the stage list is drawn from — never from a cached copy, and never
 * from an optimistic guess about what the person is about to do.
 *
 * When the plan cannot be lowered yet the counts are withheld rather than shown as zero: a
 * "0 agent executions" line beside a three-stage chain is a disagreement the person has to
 * resolve, and the blocking sentence underneath is the honest version of it.
 */
export function WorkPlanComposerSummary({
  plan,
  capacity,
  stageCount,
  runnable
}: WorkPlanComposerSummaryProps) {
  const summary = runnable ? workPlanSummary(plan, capacity) : null
  return (
    <div
      aria-label={translate('workPlan.liveChain', 'Live chain')}
      className="space-y-1 text-xs"
      data-stages={stageCount}
    >
      <p>{workPlanNotation(plan)}</p>
      <p
        aria-label={translate('workPlan.chainSummary', 'Chain summary')}
        className="text-muted-foreground"
      >
        {summary
          ? translate(
              'workPlan.summary',
              '{{executions}} agent executions · {{stages}} workflow stages · max concurrency {{concurrency}}',
              {
                executions: summary.executions,
                stages: summary.stages,
                concurrency: summary.maxConcurrency
              }
            )
          : translate(
              'workPlan.chainNotRunnable',
              '{{stages}} workflow stages · this chain cannot run yet',
              { stages: stageCount }
            )}
      </p>
      <p className="text-muted-foreground">{workPlanSentence(plan)}</p>
    </div>
  )
}
