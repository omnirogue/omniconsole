import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { DecisionContractCheck } from '../../../../shared/decision-contracts/decision-contract-check'
import { decisionContractNote } from '../../../../shared/decision-contracts/decision-contract-note'

/** How far a JEV decision has been checked against known answers: plain, muted, never a warning. */
export function WorkflowJudgeCheckLine({
  check,
  className
}: {
  check: DecisionContractCheck | undefined
  className?: string
}) {
  if (!check) {
    return null
  }
  return (
    <p
      data-testid="workflow-judge-check"
      className={cn('text-xs font-normal text-muted-foreground', className)}
    >
      {decisionContractNote(check, translate)}
    </p>
  )
}
