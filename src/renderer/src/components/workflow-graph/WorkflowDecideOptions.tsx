import { Checkbox } from '@/components/ui/checkbox'
import { translate } from '@/i18n/i18n'
import type { WorkflowRoute, WorkflowSpec } from '../../../../shared/workflow-graph'
import { workflowSetOneAnswer } from '../../../../shared/workflow-graph-decide'
import { decisionContractCheck } from '../../../../shared/decision-contracts/decision-contract-check'
import { templateContractRef } from '../../../../shared/decision-contracts/decision-points'
import { WorkflowJudgeCheckLine } from './WorkflowJudgeCheckLine'

/** Decide's one setting before Start: the opt-in one-answer route, off until it is measured. */
export function WorkflowDecideOptions({
  spec,
  available,
  onChange
}: {
  spec: WorkflowSpec
  available: readonly WorkflowRoute[]
  onChange: (spec: WorkflowSpec) => void
}) {
  const on = Boolean(spec.oneAnswer)
  const label = translate(
    'workflowGraph.decide.oneAnswer',
    'Answer one-answer questions with one model'
  )
  return (
    <section className="space-y-1 rounded-lg border bg-card p-3 text-xs">
      <label className="flex items-center gap-2 font-medium">
        <Checkbox
          checked={on}
          aria-label={label}
          onCheckedChange={(checked) =>
            onChange(workflowSetOneAnswer(spec, checked === true, available))
          }
        />
        {label}
      </label>
      <p className="text-muted-foreground">
        {translate(
          'workflowGraph.decide.oneAnswerRoute',
          'Off by default. When on, JEV first checks whether your question has one right answer, such as a fact, a sum or a lookup. Only if it is sure does one model answer it alone; otherwise the full Decide runs.'
        )}
      </p>
      <WorkflowJudgeCheckLine
        check={decisionContractCheck('route', templateContractRef(spec, 'one-answer-route'))}
      />
    </section>
  )
}
