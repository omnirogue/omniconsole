import type { NextStepOutcomeDraft } from '../../../../shared/next-step-draft'

/** What the primary button will do, so its label can say it. */
export type NextStepPrimaryAction =
  | { kind: 'save' }
  | { kind: 'start'; count: number }
  | { kind: 'send'; name: string }
  | { kind: 'handoff'; name: string }
  | { kind: 'choose-teammate' }

/**
 * A teammate without a name blocks everything; agent steps start before any person is
 * involved; a person finish is a send (feedback comes back) or a handoff (ownership moves);
 * otherwise nothing runs and Save only records the answers.
 */
export function outcomePrimaryAction(
  outcomes: readonly NextStepOutcomeDraft[]
): NextStepPrimaryAction {
  const people = outcomes
    .map((outcome) => outcome.finish)
    .filter((finish) => finish?.kind === 'person')
  if (people.some((finish) => !finish.personId)) {
    return { kind: 'choose-teammate' }
  }
  const count = outcomes.reduce((total, outcome) => total + outcome.steps.length, 0)
  if (count > 0) {
    return { kind: 'start', count }
  }
  const person = people[0]
  if (person) {
    return person.disposition === 'feedback'
      ? { kind: 'send', name: person.personName }
      : { kind: 'handoff', name: person.personName }
  }
  return { kind: 'save' }
}
