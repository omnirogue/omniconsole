import { translate } from '@/i18n/i18n'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import {
  NEXT_STEP_MAX_SEQUENTIAL_HANDOFFS,
  type NextStepOutcomeDraft,
  type NextStepOutcomeStep
} from '../../../../shared/next-step-draft'
import { NextStepAddAgentMenu } from './NextStepAddAgentMenu'
import { NextStepOutcomeSection } from './NextStepOutcomeSection'
import { NextStepOutcomeStepRow } from './NextStepOutcomeStepRow'
import { defaultActor, defaultReviewers } from './next-step-default-actor'
import {
  appendOutcomeSteps,
  moveOutcomeStep,
  newHandoffStep,
  newReviewStep,
  outcomeHandoffSteps,
  removeOutcomeStep,
  replaceOutcomeStep
} from './next-step-outcome-sections'
import { outcomeTemplateHandoffCount, outcomeTemplateSteps } from './next-step-outcome-templates'

/**
 * The one Agents list: reviews (several reviewers at once) and agents (one does the work) in
 * the order they run, each an ordinary chain step and each one line. Empty, the work goes
 * straight to the next person.
 */
export function NextStepOutcomeAgents({
  outcome,
  agents,
  worktreeSelector,
  onChange
}: {
  outcome: NextStepOutcomeDraft
  agents: AgentCatalogEntry[]
  worktreeSelector: string | null
  onChange: (outcome: NextStepOutcomeDraft) => void
}): React.JSX.Element {
  const handoffs = outcomeHandoffSteps(outcome).length
  const full = handoffs >= NEXT_STEP_MAX_SEQUENTIAL_HANDOFFS
  const last = outcome.steps.at(-1)
  const count = outcome.steps.length
  const add = (steps: readonly NextStepOutcomeStep[]): void =>
    onChange(appendOutcomeSteps(outcome, steps))
  return (
    <NextStepOutcomeSection
      id="agents"
      title={translate('nextStep.agents', 'Agents')}
      value={
        count === 0
          ? translate('nextStep.none', 'None')
          : count === 1
            ? translate('nextStep.oneStep', '1 step')
            : translate('nextStep.stepCount', '{{count}} steps', { count })
      }
      hint={
        count === 0
          ? translate('nextStep.agentsNone', 'None. It goes straight to the next step.')
          : translate(
              'nextStep.agentsOrderHint',
              'They run in this order; then the next person gets it.'
            )
      }
      action={
        <NextStepAddAgentMenu
          agentDisabledReason={
            full
              ? translate('nextStep.sixHandoffsMaximum', 'Up to six sequential agent handoffs')
              : null
          }
          templateDisabled={(id) =>
            agents.length === 0 ||
            handoffs + outcomeTemplateHandoffCount(id) > NEXT_STEP_MAX_SEQUENTIAL_HANDOFFS
          }
          onReview={() =>
            add([{ ...newReviewStep(null), reviewers: defaultReviewers(agents, last) }])
          }
          onAgent={() => add([newHandoffStep(defaultActor(agents, last))])}
          onTemplate={(id) => {
            const steps = outcomeTemplateSteps(id, agents, last)
            if (steps) {
              add(steps)
            }
          }}
        />
      }
    >
      {count ? (
        <div className="space-y-0.5" data-next-step-steps>
          {outcome.steps.map((step, index) => (
            <NextStepOutcomeStepRow
              key={step.id}
              step={step}
              previousStep={outcome.steps[index - 1]}
              followingStep={outcome.steps[index + 1]}
              index={index}
              total={count}
              agents={agents}
              worktreeSelector={worktreeSelector}
              onChange={(next) => onChange(replaceOutcomeStep(outcome, index, next))}
              onMove={(direction) => onChange(moveOutcomeStep(outcome, index, direction))}
              onRemove={() => onChange(removeOutcomeStep(outcome, index))}
            />
          ))}
        </div>
      ) : null}
    </NextStepOutcomeSection>
  )
}
