import { translate } from '@/i18n/i18n'
import { ReviewRubricSelect } from '@/components/build-review/ReviewRubricPicker'
import type {
  WorkflowJevJudge,
  WorkflowSpec,
  WorkflowStep
} from '../../../../shared/workflow-graph'
import { decisionContractCheck } from '../../../../shared/decision-contracts/decision-contract-check'
import { resolveDecisionContracts } from '../../../../shared/decision-contracts/decision-points'
import {
  workflowJevFor,
  workflowJudgesOf,
  type WorkflowJudges
} from '../../../../shared/workflow-graph-improve'
import {
  composeReviewStepInstructions,
  parseReviewStepInstructions
} from '../../../../shared/review-rubrics'
import { WorkflowSelect } from './workflow-graph-controls'
import { WorkflowJudgeCheckLine } from './WorkflowJudgeCheckLine'

/** How each judging choice reads, and what it means in one line. */
export function workflowJudgesOptions() {
  return [
    {
      value: 'jev',
      label: translate('workflowGraph.judges.jev', 'JEV · models if needed')
    },
    {
      value: 'both',
      label: translate('workflowGraph.judges.both', 'JEV and models')
    },
    {
      value: 'models',
      label: translate('workflowGraph.judges.models', 'Models only')
    }
  ]
}

export function workflowJudgesHint(judges: WorkflowJudges): string {
  return judges === 'jev'
    ? translate(
        'workflowGraph.judges.jevHint',
        'JEV judges in seconds for a fraction of a cent. The model judges step in only when JEV is unsure or unavailable.'
      )
    : judges === 'both'
      ? translate(
          'workflowGraph.judges.bothHint',
          'JEV and the model judges both vote every time; where they disagree is recorded.'
        )
      : translate('workflowGraph.judges.modelsHint', 'Only the model judges vote.')
}

/**
 * A judging step's optional settings: the rubric its judges use (kept in its instruction, so the
 * prompt, the edit history and JEV read the same text), and for Rank who judges and how JEV
 * compares. Everything has a default; nothing here is required.
 */
export function WorkflowJudgeFields({
  spec,
  step,
  onInstruction,
  onJev
}: {
  spec: WorkflowSpec
  step: WorkflowStep
  onInstruction: (instruction: string) => void
  onJev: (jev: WorkflowJevJudge | undefined) => void
}) {
  if (step.kind !== 'rank' && step.kind !== 'review') {
    return null
  }
  const parsed = parseReviewStepInstructions(step.instruction)
  const judges = workflowJudgesOf(step.jev)
  // Setup has no run, so the line reads the contract a new run would freeze for this step.
  const point = step.byCriterion ? `${step.id}/line` : `${step.id}/ballot`
  const ref = resolveDecisionContracts(spec)[point]
  return (
    <div className="grid grid-cols-2 gap-2">
      <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
        {translate('workflowGraph.editor.rubric', 'Rubric (optional)')}
        <ReviewRubricSelect
          id={`workflow-rubric-${step.id}`}
          label={translate('workflowGraph.editor.rubric', 'Rubric (optional)')}
          rubric={parsed.shared}
          emptyLabel={translate('workflowGraph.editor.noRubric', 'None: use the instruction')}
          onChange={(rubric) =>
            onInstruction(
              composeReviewStepInstructions({
                ...(rubric ? { shared: rubric } : {}),
                perReviewer: [],
                focus: parsed.focus
              })
            )
          }
        />
      </label>
      {step.kind === 'rank' && (
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          {translate('workflowGraph.editor.judges', 'Judges')}
          <WorkflowSelect
            value={judges}
            options={workflowJudgesOptions()}
            onChange={(value) => onJev(workflowJevFor(value as WorkflowJudges, step.jev))}
          />
          <span className="font-normal">{workflowJudgesHint(judges)}</span>
          {ref && <WorkflowJudgeCheckLine check={decisionContractCheck(point, ref)} />}
        </label>
      )}
      {step.kind === 'rank' && step.jev && (
        <label className="col-span-2 flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          {translate('workflowGraph.editor.jevMethod', 'How JEV compares')}
          <WorkflowSelect
            value={step.jev.method}
            options={[
              {
                value: 'auto',
                label: translate(
                  'workflowGraph.editor.jevAuto',
                  'Automatic: head to head for a few answers, rubric scores for many'
                )
              },
              {
                value: 'rubric',
                label: translate(
                  'workflowGraph.editor.jevRubric',
                  'Rubric scores: each answer scored on every criterion'
                )
              },
              {
                value: 'pairwise',
                label: translate(
                  'workflowGraph.editor.jevPairwise',
                  'Head to head: every pair, in both orders'
                )
              }
            ]}
            onChange={(value) =>
              onJev({ ...step.jev!, method: value as WorkflowJevJudge['method'] })
            }
          />
        </label>
      )}
    </div>
  )
}
