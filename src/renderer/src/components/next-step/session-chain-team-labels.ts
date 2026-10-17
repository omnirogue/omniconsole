import { translate } from '@/i18n/i18n'
import { NEXT_STEP_SHAPE_GLYPH } from '../../../../shared/next-step-glyphs'
import type {
  SessionChainAgentStep,
  SessionChainStepRole
} from '../../../../shared/session-chain-types'
import type { SessionChainTeamSummary } from '../../../../shared/session-chain-team'

export function sessionChainStepRoleLabel(role: SessionChainStepRole): string {
  switch (role) {
    case 'producer':
      return translate('nextStep.teamRoleProducer', 'Producer')
    case 'worker':
      return translate('nextStep.teamRoleWorker', 'Implementer')
    case 'reviewer':
      return translate('nextStep.teamRoleReviewer', 'Reviewer')
    case 'repair':
      return translate('nextStep.teamRoleRepair', 'Repair')
  }
}

/** Review round of rounds, the round a repair follows, or a legacy repeated step's position. */
export function sessionChainStepRoundLabel(step: SessionChainAgentStep): string | null {
  if (step.review) {
    return `${NEXT_STEP_SHAPE_GLYPH.rounds} ${step.review.round}/${step.review.maxRounds}`
  }
  if (step.reviewRepair) {
    return translate('nextStep.teamRepairAfterRound', 'after round {{value0}}', {
      value0: String(step.reviewRepair.afterRound)
    })
  }
  return step.round
    ? `${NEXT_STEP_SHAPE_GLYPH.rounds} ${step.round.index}/${step.round.total}`
    : null
}

export function sessionChainTeamHeadline(summary: SessionChainTeamSummary | null): string | null {
  if (!summary) {
    return null
  }
  const implementers = summary.counts.producer + summary.counts.worker
  const shape = [
    translate('nextStep.teamImplementers', '{{value0}} implementers', {
      value0: String(implementers)
    }),
    summary.counts.reviewer
      ? translate('nextStep.teamReviewers', '{{value0}} reviewers × {{value1}} rounds', {
          value0: String(summary.counts.reviewer),
          value1: String(summary.maxRounds)
        })
      : null,
    summary.parallelGroups.length
      ? `${NEXT_STEP_SHAPE_GLYPH.parallel} ${translate('nextStep.teamParallel', 'parallel')}`
      : null
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')
  return summary.planning
    ? translate('nextStep.teamPlannedByAgent', 'Team planned by the agent: {{value0}}', {
        value0: shape
      })
    : shape
}
