import { describe, expect, it } from 'vitest'
import { validateNextOutcomeIntentSubmission } from './next-outcome-intent-definition'
import type { SessionOutcomeDefinition } from './session-outcome-types'

const definition = (
  id: string,
  instructions = 'Save /output/result.md'
): SessionOutcomeDefinition => ({
  id,
  title: id,
  finish: 'complete',
  instructions,
  dependsOn: [],
  conditions: [{ id: 'file', kind: 'file', target: '/output/result.md' }],
  actions: [
    {
      id: 'write',
      instruction: instructions,
      conditionIds: ['file'],
      authority: 'existing-user-authority',
      agent: 'codex'
    }
  ]
})
const source = { prompt: 'Save /output/result.md', expectedRevision: 0, outcomes: [] }
const input = () => ({
  sourcePrompt: source.prompt,
  expectedRevision: 0,
  outcomes: [definition('first')]
})

describe('source agent structured outcome intent', () => {
  it('retains separate outcomes, dependency ordering, actor and exact destinations', () => {
    const submitted = {
      ...input(),
      outcomes: [definition('first'), { ...definition('second'), dependsOn: ['first'] }]
    }
    expect(validateNextOutcomeIntentSubmission(submitted, source)).toEqual(submitted)
  })
  it('rejects stale prompt and revision instead of binding another source turn', () => {
    expect(() =>
      validateNextOutcomeIntentSubmission({ ...input(), sourcePrompt: 'Other user prompt' }, source)
    ).toThrow('Source prompt')
    expect(() =>
      validateNextOutcomeIntentSubmission({ ...input(), expectedRevision: 1 }, source)
    ).toThrow('revision')
  })
  it('rejects omitted prior obligations regardless of partial success', () => {
    expect(() =>
      validateNextOutcomeIntentSubmission(input(), { ...source, outcomes: [definition('prior')] })
    ).toThrow('cannot silently remove')
  })
  it('does not accept publication proven by a written note or human review of the note', () => {
    expect(() =>
      validateNextOutcomeIntentSubmission(
        { ...input(), outcomes: [definition('first', 'Publish video to YouTube')] },
        source
      )
    ).toThrow('local result note')
  })
  it('rejects changing an explicit destination to a report proxy', () => {
    const result = definition('first')
    result.conditions[0].target = '/work/result.md'
    expect(() =>
      validateNextOutcomeIntentSubmission({ ...input(), outcomes: [result] }, source)
    ).toThrow('exact path')
  })
  it('strictly rejects caller authority assertions and unknown dependencies', () => {
    expect(() =>
      validateNextOutcomeIntentSubmission({ ...input(), authorized: true }, source)
    ).toThrow()
    const result = definition('first')
    result.dependsOn = ['absent']
    expect(() =>
      validateNextOutcomeIntentSubmission({ ...input(), outcomes: [result] }, source)
    ).toThrow('does not exist')
  })
})

it('cannot substitute an unrelated Git or person receipt for video publication', () => {
  const result = definition('first', 'Publish video to YouTube')
  result.conditions = [
    { id: 'file', kind: 'pr', target: 'org/repo', repository: 'org/repo', branch: 'feature' }
  ]
  expect(() =>
    validateNextOutcomeIntentSubmission({ ...input(), outcomes: [result] }, source)
  ).toThrow('actual destination')
})
