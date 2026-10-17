import { translate } from '@/i18n/i18n'
import type { LocalWorkflowGraphRound } from '../../../../shared/local-workflow-view'
import { workflowEvidenceLabel } from './workflow-graph-labels'

type Target = NonNullable<LocalWorkflowGraphRound['targets']>[number]

/** How important the item was rated, how firmly it was checked, and why none checked it. */
export function WorkflowTargetMarks({ target }: { target: Target }) {
  const reviews = target.votes.filter(Boolean).length
  const quote = workflowEvidenceLabel(target.evidence?.status)
  return (
    <>
      {quote ? <span className="text-[11px] text-muted-foreground">{quote}</span> : null}
      {target.impact ? (
        <span className="font-mono text-[11px] text-muted-foreground" title={target.impact.why}>
          {translate('workflowGraph.detail.impact', 'impact {{score}}/5', {
            score: target.impact.score
          })}
        </span>
      ) : null}
      {target.tally === 'confirmed' && reviews === 1 ? (
        <span
          className="text-[11px] text-muted-foreground"
          title={
            target.crossChecked
              ? translate(
                  'workflowGraph.detail.oneReviewHint',
                  'One reviewer from another model family passed it; more join only when a review does not pass or the item is critical.'
                )
              : translate(
                  'workflowGraph.detail.oneReviewPlainHint',
                  'One reviewer passed it; more join only when a review does not pass or the item is critical.'
                )
          }
        >
          {translate('workflowGraph.detail.oneReview', 'one review')}
        </span>
      ) : null}
      {target.sameFamilyOnly ? (
        <span
          className="text-[11px] text-muted-foreground"
          title={translate(
            'workflowGraph.detail.sameFamilyOnlyHint',
            'Only reviewers from the same model family as its finders passed it, so it is not counted as confirmed.'
          )}
        >
          {translate('workflowGraph.detail.sameFamilyOnly', 'same-family pass only')}
        </span>
      ) : null}
      {target.jev ? (
        <span
          className="font-mono text-[11px] text-muted-foreground"
          title={translate('workflowGraph.detail.jevScoreHint', 'JEV screening score, 0 to 4')}
        >
          {translate('workflowGraph.detail.jevScore', 'JEV {{score}}', {
            score: target.jev.score.toFixed(1)
          })}
        </span>
      ) : null}
      {target.unchecked ? (
        <span className="text-[11px] text-muted-foreground">
          {target.screened
            ? translate('workflowGraph.detail.screened', 'set aside by JEV as a non-finding')
            : target.confirmedBy === 'jev' || target.refutedBy === 'jev'
              ? translate('workflowGraph.detail.uncheckedByJev', 'over the limit: decided by JEV')
              : translate('workflowGraph.detail.unchecked', 'not checked: over the limit')}
        </span>
      ) : null}
    </>
  )
}
