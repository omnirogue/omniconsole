import type { ReviewerSeat } from '@/components/build-review/BuildReviewReviewerSettings'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  NEXT_STEP_MAX_REVIEW_ROUNDS,
  NEXT_STEP_MAX_REVIEWERS,
  defaultNextStepInstructions,
  emptyNextStepDraft,
  emptyNextStepOutcomeDraft,
  type NextStepActor,
  type NextStepDraft,
  type NextStepOutcomeDraft,
  type NextStepOutcomeFinish,
  type NextStepOutcomeStep
} from '../../../../shared/next-step-draft'
import type { SessionActionPresetId } from '../../../../shared/session-action-presets'

export type NextStepReviewStep = Extract<NextStepOutcomeStep, { kind: 'review' }>
export type NextStepHandoffStep = Extract<NextStepOutcomeStep, { kind: 'handoff' }>
export type NextStepPersonFinish = Extract<NextStepOutcomeFinish, { kind: 'person' }>

/** Who gets the work after the agents: the two visible choices plus a legacy GitHub finish. */
export type NextPersonChoice = 'me' | 'team' | 'github'

/** What a teammate does with it: feedback comes back to me, ownership moves to them. */
export type NextStepTeammateMode = 'review' | 'handoff'

/** Build & Review starts at three rounds; the outcome runtime allows up to five. */
export const NEXT_STEP_DEFAULT_REVIEW_ROUNDS = 3

/** A fresh outcome already answers "back to me", so the default path needs no click. */
export function defaultNextStepOutcomeDraft(): NextStepOutcomeDraft {
  return { ...emptyNextStepOutcomeDraft(), finish: { kind: 'complete' } }
}

/** A finish nobody chose reads as Me; the saved value is only rewritten on Save. */
export function withDefaultFinish(outcome: NextStepOutcomeDraft): NextStepOutcomeDraft {
  return outcome.finish ? outcome : { ...outcome, finish: { kind: 'complete' } }
}

export function outcomeReviewStep(outcome: NextStepOutcomeDraft): NextStepReviewStep | null {
  return outcome.steps.find((step): step is NextStepReviewStep => step.kind === 'review') ?? null
}

/** Review steps beyond the first come from an earlier version; the sections keep them as they are. */
export function extraReviewStepCount(outcome: NextStepOutcomeDraft): number {
  return Math.max(0, outcome.steps.filter((step) => step.kind === 'review').length - 1)
}

export function outcomeHandoffSteps(outcome: NextStepOutcomeDraft): NextStepHandoffStep[] {
  return outcome.steps.filter((step): step is NextStepHandoffStep => step.kind === 'handoff')
}

/** The step a new review would follow: the handoff just before it, if any. */
export function stepBeforeReview(outcome: NextStepOutcomeDraft): NextStepOutcomeStep | undefined {
  const index = outcome.steps.findIndex((step) => step.kind === 'review')
  return index > 0 ? outcome.steps[index - 1] : undefined
}

export function newReviewStep(
  reviewer: NextStepActor | null,
  maxRounds = NEXT_STEP_DEFAULT_REVIEW_ROUNDS
): NextStepReviewStep {
  return {
    id: crypto.randomUUID(),
    kind: 'review',
    reviewers: reviewer ? [reviewer] : [],
    maxRounds: clampReviewRounds(maxRounds),
    ...(clampReviewRounds(maxRounds) > 1 ? { repairWithSource: true } : {}),
    instructions: '',
    adversarial: false
  }
}

export function newHandoffStep(
  actor: NextStepActor | null,
  presetId: SessionActionPresetId = 'implement'
): NextStepHandoffStep {
  return {
    id: crypto.randomUUID(),
    kind: 'handoff',
    actor,
    presetId,
    instructions: defaultNextStepInstructions(presetId)
  }
}

/**
 * Replace (or remove) the first review step in place; a brand-new review runs before the
 * agents. Other steps keep their positions so a committed plan is never reordered silently.
 */
export function withReviewStep(
  outcome: NextStepOutcomeDraft,
  step: NextStepReviewStep | null
): NextStepOutcomeDraft {
  const index = outcome.steps.findIndex((entry) => entry.kind === 'review')
  if (index === -1) {
    return step ? { ...outcome, steps: [step, ...outcome.steps] } : outcome
  }
  const steps = step
    ? outcome.steps.map((entry, current) => (current === index ? step : entry))
    : outcome.steps.filter((_, current) => current !== index)
  return { ...outcome, steps }
}

/** Refill the handoff slots in order; review steps stay where they were, extra handoffs append. */
export function withHandoffSteps(
  outcome: NextStepOutcomeDraft,
  handoffs: readonly NextStepHandoffStep[]
): NextStepOutcomeDraft {
  const queue = [...handoffs]
  const steps: NextStepOutcomeStep[] = []
  for (const step of outcome.steps) {
    if (step.kind !== 'handoff') {
      steps.push(step)
      continue
    }
    const next = queue.shift()
    if (next) {
      steps.push(next)
    }
  }
  return { ...outcome, steps: [...steps, ...queue] }
}

export function moveHandoffStep(
  handoffs: readonly NextStepHandoffStep[],
  index: number,
  direction: -1 | 1
): NextStepHandoffStep[] {
  return moveStep(handoffs, index, direction)
}

function moveStep<T>(steps: readonly T[], index: number, direction: -1 | 1): T[] {
  const destination = index + direction
  if (destination < 0 || destination >= steps.length) {
    return [...steps]
  }
  const next = [...steps]
  ;[next[index], next[destination]] = [next[destination]!, next[index]!]
  return next
}

/** The one Agents list edits steps by position; review and agent steps interleave as saved. */
export function replaceOutcomeStep(
  outcome: NextStepOutcomeDraft,
  index: number,
  step: NextStepOutcomeStep
): NextStepOutcomeDraft {
  return {
    ...outcome,
    steps: outcome.steps.map((entry, current) => (current === index ? step : entry))
  }
}

export function moveOutcomeStep(
  outcome: NextStepOutcomeDraft,
  index: number,
  direction: -1 | 1
): NextStepOutcomeDraft {
  return { ...outcome, steps: moveStep(outcome.steps, index, direction) }
}

export function removeOutcomeStep(
  outcome: NextStepOutcomeDraft,
  index: number
): NextStepOutcomeDraft {
  return { ...outcome, steps: outcome.steps.filter((_, current) => current !== index) }
}

export function appendOutcomeSteps(
  outcome: NextStepOutcomeDraft,
  steps: readonly NextStepOutcomeStep[]
): NextStepOutcomeDraft {
  return { ...outcome, steps: [...outcome.steps, ...steps] }
}

/** A preset change refreshes instructions only while they still read as the previous default. */
export function handoffWithPreset(
  step: NextStepHandoffStep,
  presetId: SessionActionPresetId
): NextStepHandoffStep {
  const untouched = step.instructions.trim() === defaultNextStepInstructions(step.presetId).trim()
  return {
    ...step,
    presetId,
    instructions: untouched ? defaultNextStepInstructions(presetId) : step.instructions
  }
}

export function nextPersonChoice(finish: NextStepOutcomeFinish | null): NextPersonChoice {
  switch (finish?.kind) {
    case 'person':
      return 'team'
    case 'github':
      return 'github'
    case 'complete':
    case 'my-review':
    case undefined:
      return 'me'
  }
}

export function finishForNextPerson(choice: 'me' | 'team'): NextStepOutcomeFinish {
  return choice === 'me'
    ? { kind: 'complete' }
    : { kind: 'person', personId: '', personName: '', disposition: 'ownership', action: 'review' }
}

/** Feedback returns the work to me; anything else hands ownership to the teammate. */
export function teammateMode(finish: NextStepPersonFinish): NextStepTeammateMode {
  return finish.disposition === 'feedback' ? 'review' : 'handoff'
}

export function finishWithTeammateMode(
  finish: NextStepPersonFinish,
  mode: NextStepTeammateMode
): NextStepPersonFinish {
  return {
    ...finish,
    disposition: mode === 'review' ? 'feedback' : 'ownership',
    action: 'review'
  }
}

export function clampReviewRounds(value: number): number {
  return Number.isInteger(value) ? Math.min(Math.max(value, 1), NEXT_STEP_MAX_REVIEW_ROUNDS) : 1
}

/** Build + Review seats are the same shape as reviewers; the index is the seat id. */
export function reviewerSeats(reviewers: readonly NextStepActor[]): ReviewerSeat[] {
  return reviewers.map((reviewer, index) => ({
    id: index,
    choice: {
      agent: reviewer.agent,
      ...(reviewer.model ? { model: reviewer.model } : {}),
      ...(reviewer.effort ? { effort: reviewer.effort } : {})
    }
  }))
}

/** Seats back to reviewers, keeping a saved account override on a seat that only changed model. */
export function reviewersFromSeats(
  seats: readonly ReviewerSeat[],
  previous: readonly NextStepActor[]
): NextStepActor[] {
  return seats.slice(0, NEXT_STEP_MAX_REVIEWERS).map((seat) => {
    const before = previous[seat.id]
    const sameAgent = before?.agent === seat.choice.agent
    return {
      agent: seat.choice.agent as TuiAgent,
      ...(seat.choice.model ? { model: seat.choice.model } : {}),
      ...(seat.choice.effort ? { effort: seat.choice.effort } : {}),
      ...(before?.openrouterCandidates !== undefined
        ? { openrouterCandidates: [...before.openrouterCandidates] }
        : {}),
      ...(sameAgent && before?.accountChoiceId !== undefined
        ? { accountChoiceId: before.accountChoiceId }
        : {})
    }
  })
}

/** "Claude opus high" — the agent with its model and effort whenever they are set. */
export function describeReviewer(
  actor: NextStepActor,
  agentName: (agent: TuiAgent) => string
): string {
  return [agentName(actor.agent), actor.model, actor.effort].filter(Boolean).join(' ')
}

/** A fresh dialog already answers Me → Mark Complete; nothing is asked before Save. */
export function initialOutcomeDraft(): NextStepDraft {
  return { ...emptyNextStepDraft(), outcomes: [defaultNextStepOutcomeDraft()] }
}

/** An untouched outcome shows Me; Save writes that answer instead of refusing a null finish. */
export function withDefaultFinishes(draft: NextStepDraft): NextStepDraft {
  return { ...draft, outcomes: (draft.outcomes ?? []).map(withDefaultFinish) }
}
