import { translate } from '@/i18n/i18n'
import {
  WORKFLOW_DEFAULT_IMPROVE_ROUNDS,
  WORKFLOW_MAX_IMPROVE_ROUNDS,
  WORKFLOW_MAX_ROUNDS,
  type WorkflowRoute,
  type WorkflowSpec
} from '../../../../shared/workflow-graph'
import { workflowRepeatCandidates, workflowSetRepeat } from '../../../../shared/workflow-graph-edit'
import { WorkflowSelect } from './workflow-graph-controls'

/**
 * Repeat, offered only where it means something: a Review that reads a Do ("until approved"
 * revises one draft; "until nothing new" keeps listing and reviewing until a round is dry), or a
 * Rank that reads a Do ("improve" keeps the best version until more rounds stop helping).
 */
export function WorkflowRepeatControl({
  spec,
  available,
  onChange
}: {
  spec: WorkflowSpec
  available: readonly WorkflowRoute[]
  onChange: (spec: WorkflowSpec) => void
}) {
  const candidates = workflowRepeatCandidates(spec)
  if (!candidates.length) {
    return null
  }
  const options = [
    { value: '', label: translate('workflowGraph.repeat.none', 'No repeat') },
    ...candidates.flatMap(({ do: doStep, review }) =>
      (review.kind === 'rank'
        ? doStep.list
          ? []
          : (['plateau'] as const)
        : doStep.list
          ? (['nothing-new'] as const)
          : (['approved'] as const)
      ).map((until) => ({
        value: `${doStep.id}|${review.id}|${until}`,
        label:
          until === 'plateau'
            ? translate(
                'workflowGraph.repeat.optionImprove',
                'Improve {{do}} until {{review}} sees no gain',
                { do: doStep.title, review: review.title }
              )
            : until === 'approved'
              ? translate(
                  'workflowGraph.repeat.optionApproved',
                  'Revise {{do}} until {{review}} approves',
                  { do: doStep.title, review: review.title }
                )
              : translate(
                  'workflowGraph.repeat.optionDry',
                  'Repeat {{do}} and {{review}} until nothing new',
                  { do: doStep.title, review: review.title }
                )
      }))
    )
  ]
  const current = spec.repeat ? `${spec.repeat.do}|${spec.repeat.review}|${spec.repeat.until}` : ''
  return (
    <div className="flex items-center gap-1.5">
      <WorkflowSelect
        className="w-64"
        value={options.some((option) => option.value === current) ? current : ''}
        options={options}
        onChange={(value) => {
          if (!value) {
            onChange(workflowSetRepeat(spec, undefined, available))
            return
          }
          const [doId, reviewId, until] = value.split('|')
          onChange(
            workflowSetRepeat(
              spec,
              {
                do: doId,
                review: reviewId,
                until: until as 'approved' | 'nothing-new' | 'plateau',
                maxRounds:
                  until === 'plateau'
                    ? WORKFLOW_DEFAULT_IMPROVE_ROUNDS
                    : Math.min(spec.repeat?.maxRounds ?? 3, WORKFLOW_MAX_ROUNDS)
              },
              available
            )
          )
        }}
      />
      {spec.repeat && (
        <WorkflowSelect
          className="w-28"
          value={String(spec.repeat.maxRounds)}
          options={Array.from(
            {
              length:
                spec.repeat.until === 'plateau' ? WORKFLOW_MAX_IMPROVE_ROUNDS : WORKFLOW_MAX_ROUNDS
            },
            (_, index) => index + 1
          ).map((count) => ({
            value: String(count),
            label: translate('workflowGraph.repeat.rounds', 'max {{count}} rounds', { count })
          }))}
          onChange={(value) =>
            onChange(
              workflowSetRepeat(spec, { ...spec.repeat!, maxRounds: Number(value) }, available)
            )
          }
        />
      )}
    </div>
  )
}
