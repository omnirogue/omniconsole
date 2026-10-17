import { translate } from '@/i18n/i18n'
import type { DecisionContractCheck } from '../../../../shared/decision-contracts/decision-contract-check'
import {
  councilFinalCheckNote,
  type CouncilFinalCheck
} from '../../../../shared/workflow-council-final-check'
import { WorkflowJudgeCheckLine } from './WorkflowJudgeCheckLine'

export function WorkflowCouncilFinalCheck({
  check,
  judgeCheck
}: {
  check: CouncilFinalCheck
  /** How far the check's JEV rule has been checked against known answers, when JEV decided. */
  judgeCheck?: DecisionContractCheck
}) {
  return (
    <div className="space-y-1 text-xs">
      <p>{councilFinalCheckNote(check, translate)}</p>
      {check.judgedBy.length > 0 && (
        <p className="text-muted-foreground">
          {check.judgedBy.includes('jev') && check.judgedBy.includes('models')
            ? translate('workflowGraph.finalCheck.jevAndModels', 'Decided by JEV and model judges.')
            : check.judgedBy.includes('models')
              ? translate('workflowGraph.finalCheck.models', 'Decided by model judges.')
              : translate('workflowGraph.finalCheck.jev', 'Decided by JEV.')}
        </p>
      )}
      {check.judgedBy.includes('jev') && <WorkflowJudgeCheckLine check={judgeCheck} />}
    </div>
  )
}
