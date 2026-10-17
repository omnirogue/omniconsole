import { expect, it } from 'vitest'
import {
  emptyNextStepOutcomeDraft,
  type NextStepOutcomeDraft,
  type NextStepOutcomeStep
} from '../../../../shared/next-step-draft'
import { outcomePrimaryAction } from './next-step-outcome-primary-action'

const handoff: NextStepOutcomeStep = {
  id: 'a',
  kind: 'handoff',
  actor: { agent: 'codex' },
  presetId: 'implement',
  instructions: ''
}
const review: NextStepOutcomeStep = {
  id: 'r',
  kind: 'review',
  reviewers: [{ agent: 'claude' }],
  maxRounds: 3,
  instructions: '',
  adversarial: false
}
const outcome = (patch: Partial<NextStepOutcomeDraft>): NextStepOutcomeDraft => ({
  ...emptyNextStepOutcomeDraft(),
  finish: { kind: 'complete' },
  ...patch
})
const josh = (disposition: 'ownership' | 'feedback'): NextStepOutcomeDraft['finish'] => ({
  kind: 'person',
  personId: 'josh',
  personName: 'Josh',
  action: 'review',
  disposition
})

it('only saves when nothing runs', () => {
  expect(outcomePrimaryAction([outcome({})])).toEqual({ kind: 'save' })
  expect(outcomePrimaryAction([outcome({ finish: { kind: 'my-review' } })])).toEqual({
    kind: 'save'
  })
  expect(outcomePrimaryAction([])).toEqual({ kind: 'save' })
})

it('starts the agent steps, counting reviews and agents across every outcome', () => {
  expect(outcomePrimaryAction([outcome({ steps: [review, handoff] })])).toEqual({
    kind: 'start',
    count: 2
  })
  expect(
    outcomePrimaryAction([outcome({ steps: [handoff] }), outcome({ steps: [handoff, handoff] })])
  ).toEqual({ kind: 'start', count: 3 })
  expect(outcomePrimaryAction([outcome({ steps: [handoff], finish: josh('ownership') })])).toEqual({
    kind: 'start',
    count: 1
  })
})

it('sends for feedback or hands off ownership to the named teammate', () => {
  expect(outcomePrimaryAction([outcome({ finish: josh('feedback') })])).toEqual({
    kind: 'send',
    name: 'Josh'
  })
  expect(outcomePrimaryAction([outcome({ finish: josh('ownership') })])).toEqual({
    kind: 'handoff',
    name: 'Josh'
  })
})

it('waits for a teammate before anything else', () => {
  const nobody = { ...josh('ownership')!, personId: '', personName: '' }
  expect(outcomePrimaryAction([outcome({ finish: nobody, steps: [handoff] })])).toEqual({
    kind: 'choose-teammate'
  })
})
