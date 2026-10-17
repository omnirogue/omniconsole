import { FleetFallbackFields } from './FleetFallbackFields'
import { reviewerFallbackProblem } from './local-fallback-selection'
import { useId } from 'react'
import { translate } from '@/i18n/i18n'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { BuildReviewReviewerSettings } from '@/components/build-review/BuildReviewReviewerSettings'
import {
  ReviewRubricPicker,
  ReviewRubricSelect
} from '@/components/build-review/ReviewRubricPicker'
import {
  composeReviewStepInstructions,
  parseReviewStepInstructions,
  type ReviewStepRubrics
} from '../../../../shared/review-rubrics'
import {
  NEXT_STEP_MAX_REVIEW_ROUNDS,
  NEXT_STEP_MAX_REVIEWERS,
  type NextStepOutcomeStep
} from '../../../../shared/next-step-draft'
import {
  clampReviewRounds,
  reviewerSeats,
  reviewersFromSeats,
  type NextStepReviewStep
} from './next-step-outcome-sections'
import { nextReviewerSeat, type NextStepSeatAgent } from './next-step-reviewer-seat'

const NO_AGENTS: readonly NextStepSeatAgent[] = []

/**
 * One review step, edited with Build & Review's own controls: up to five seats, each with
 * agent, model and effort; the rounds field with its help; the review focus; adversarial
 * scrutiny. Nothing here is a second reviewer system.
 */
export function NextStepOutcomeReviewFields({
  step,
  previousStep,
  agents = NO_AGENTS,
  hasRepairAgent = false,
  worktreeSelector,
  onChange
}: {
  step: NextStepReviewStep
  previousStep?: NextStepOutcomeStep
  agents?: readonly NextStepSeatAgent[]
  hasRepairAgent?: boolean
  worktreeSelector: string | null
  onChange: (step: NextStepReviewStep) => void
}): React.JSX.Element {
  const focusId = useId()
  const rubricId = useId()
  const rubrics = parseReviewStepInstructions(step.instructions)
  const setRubrics = (next: ReviewStepRubrics) =>
    onChange({ ...step, instructions: composeReviewStepInstructions(next) })
  const producer = previousStep?.kind === 'handoff' ? previousStep.actor : null
  const occurrences = new Map<string, number>()
  const reviewerRows = step.reviewers.map((actor, index) => {
    const identity = JSON.stringify([
      actor.agent,
      actor.model,
      actor.effort,
      actor.accountChoiceId,
      actor.openrouterCandidates
    ])
    const occurrence = occurrences.get(identity) ?? 0
    occurrences.set(identity, occurrence + 1)
    return { actor, index, key: JSON.stringify([step.id, identity, occurrence]) }
  })
  return (
    <div className="space-y-3">
      <BuildReviewReviewerSettings
        capabilityMode="task-continuation"
        idPrefix={`next-step-review-${step.id}`}
        maxReviewers={NEXT_STEP_MAX_REVIEWERS}
        maxRoundsLimit={NEXT_STEP_MAX_REVIEW_ROUNDS}
        reviewersRunTogether
        worktree={worktreeSelector ?? ''}
        nextSeat={(seats) =>
          nextReviewerSeat(agents, [
            ...(producer ? [producer] : []),
            ...reviewersFromSeats(seats, step.reviewers)
          ])
        }
        seats={reviewerSeats(step.reviewers)}
        onChange={(seats) =>
          onChange({
            ...step,
            reviewers: reviewersFromSeats(seats, step.reviewers),
            // A seat's own rubric follows the seat when others are added or removed.
            instructions: composeReviewStepInstructions({
              ...rubrics,
              perReviewer: seats.map((seat) => rubrics.perReviewer[seat.id])
            })
          })
        }
        maxRounds={step.maxRounds}
        onRoundsChange={(rounds) =>
          onChange({
            ...step,
            maxRounds: clampReviewRounds(rounds),
            repairWithSource: !hasRepairAgent && clampReviewRounds(rounds) > 1
          })
        }
      />
      {reviewerRows.map(({ actor, index, key }) =>
        actor.openrouterCandidates !== undefined ? (
          <div key={key} className="space-y-1">
            <p className="text-xs font-medium">
              {translate('nextStep.fleetFallback.reviewer', 'Reviewer {{number}} saved route', {
                number: index + 1
              })}
            </p>
            <FleetFallbackFields
              primary={null}
              candidates={actor.openrouterCandidates}
              choices={[]}
              canEnable={false}
              problem={reviewerFallbackProblem(actor)}
              onChange={(openrouterCandidates) =>
                onChange({
                  ...step,
                  reviewers: step.reviewers.map((reviewer, at) =>
                    at === index ? { ...reviewer, openrouterCandidates } : reviewer
                  )
                })
              }
            />
          </div>
        ) : null
      )}
      {!hasRepairAgent && step.maxRounds > 1 ? (
        <label className="flex items-center gap-2 text-xs">
          <Checkbox
            checked={step.repairWithSource === true}
            onCheckedChange={(checked) => onChange({ ...step, repairWithSource: checked === true })}
          />
          {translate('nextStep.repairWithSource', 'Repair findings with the original builder')}
        </label>
      ) : null}
      <div className="space-y-1">
        <Label htmlFor={rubricId} className="text-xs">
          {translate('nextStep.rubric.all', 'Rubric for all reviewers')}
        </Label>
        <ReviewRubricPicker
          id={rubricId}
          rubric={rubrics.shared}
          emptyLabel={translate('nextStep.rubric.none', 'No rubric (general review)')}
          onChange={(shared) =>
            setRubrics({ ...rubrics, ...(shared ? { shared } : { shared: undefined }) })
          }
        />
        {step.reviewers.length > 1 &&
          step.reviewers.map((_actor, index) => (
            <div key={`${step.id}-rubric-${index}`} className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-xs text-muted-foreground">
                {translate('nextStep.rubric.reviewer', 'Reviewer {{number}}', {
                  number: index + 1
                })}
              </span>
              <div className="min-w-0 flex-1">
                <ReviewRubricSelect
                  id={`${rubricId}-${index}`}
                  label={translate(
                    'nextStep.rubric.reviewerLabel',
                    'Rubric for reviewer {{number}}',
                    {
                      number: index + 1
                    }
                  )}
                  rubric={rubrics.perReviewer[index]}
                  emptyLabel={translate('nextStep.rubric.same', 'Same as all')}
                  onChange={(rubric) =>
                    setRubrics({
                      ...rubrics,
                      perReviewer: step.reviewers.map((_reviewer, at) =>
                        at === index ? rubric : rubrics.perReviewer[at]
                      )
                    })
                  }
                />
              </div>
            </div>
          ))}
      </div>
      <div className="space-y-1">
        <Label htmlFor={focusId} className="text-xs">
          {translate(
            'auto.components.build-review.BuildReviewStartDialog.focus',
            'Review focus (optional)'
          )}
        </Label>
        <Textarea
          id={focusId}
          rows={2}
          value={rubrics.focus}
          placeholder={translate(
            'buildReview.focusPlaceholder',
            'Tell reviewers what to check. Example: correctness, security, edge cases, accessibility, and passing tests. Leave blank for a general review.'
          )}
          onChange={(event) => setRubrics({ ...rubrics, focus: event.target.value })}
        />
      </div>
      <label className="flex items-center gap-2 text-xs">
        <Checkbox
          checked={step.adversarial}
          onCheckedChange={(checked) => onChange({ ...step, adversarial: checked === true })}
        />
        {translate('nextStep.adversarialScrutiny', 'Adversarial scrutiny')}
      </label>
    </div>
  )
}
