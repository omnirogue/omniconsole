import { describe, expect, it } from 'vitest'
import { decisionContractNote, unknownFallbackNote } from './decision-contract-note'
import { UNKNOWN_OUTCOMES, type UnknownOutcome } from './decision-contract-types'
import type { JudgeCheckState } from './decision-contract-check'

const FALLBACK_WORDS: Record<UnknownOutcome, string> = {
  'models-decide': 'the model judges decide',
  'keep-and-verify': 'a reviewer checks it',
  'full-workflow': 'the full Decide runs',
  'keep-incumbent': 'the best version so far stays',
  'keep-chair': "the chairman's answer is kept",
  gap: 'it is listed as a gap'
}

const STATES: JudgeCheckState[] = ['checked', 'too-few', 'failing', 'not-yet', 'stale']

describe('decisionContractNote', () => {
  it('reads each fallback in plain words', () => {
    for (const fallback of UNKNOWN_OUTCOMES) {
      expect(unknownFallbackNote(fallback)).toBe(FALLBACK_WORDS[fallback])
    }
  })

  it('says how far a checked rule agreed, and what happens when JEV is unsure', () => {
    expect(
      decisionContractNote({
        state: 'checked',
        count: 120,
        agree: 97,
        unsure: 8,
        fallback: 'models-decide'
      })
    ).toBe(
      'Checked against 120 questions with known answers. When JEV was sure, it agreed 97% of the time. It was unsure 8% of the time; then the model judges decide.'
    )
  })

  it('reads a thin check as too few to rely on', () => {
    expect(decisionContractNote({ state: 'too-few', count: 15, fallback: 'keep-and-verify' })).toBe(
      'Checked against only 15 known answers so far: too few to rely on.'
    )
  })

  it('reads a failing check as a first opinion', () => {
    expect(decisionContractNote({ state: 'failing', count: 90, fallback: 'keep-chair' })).toBe(
      'Checked against 90 known answers, and JEV was wrong too often when sure, so treat its judgement here as a first opinion.'
    )
  })

  it('reads an unchecked rule as a first opinion with its fallback', () => {
    expect(decisionContractNote({ state: 'not-yet', fallback: 'full-workflow' })).toBe(
      "Not yet checked against known answers. Treat JEV's judgement here as a first opinion; when it is unsure, the full Decide runs."
    )
  })

  it('reads a stale check as no longer counting', () => {
    expect(decisionContractNote({ state: 'stale', fallback: 'gap' })).toBe(
      'How JEV judges this has changed since it was last checked, so that check no longer counts.'
    )
  })

  it('never uses the words people are not told', () => {
    for (const state of STATES) {
      for (const fallback of UNKNOWN_OUTCOMES) {
        const note = decisionContractNote({ state, count: 3, agree: 1, unsure: 2, fallback })
        expect(note).not.toMatch(/calibrat|contract|noul|rubric/i)
        expect(note).not.toMatch(/\{\{/)
      }
    }
  })

  it('passes each key and its values through translate', () => {
    const seen: [string, Record<string, unknown> | undefined][] = []
    const translate = (key: string, fallback: string, options?: Record<string, unknown>) => {
      seen.push([key, options])
      return fallback
    }
    decisionContractNote(
      { state: 'checked', count: 1, agree: 2, unsure: 3, fallback: 'gap' },
      translate
    )
    expect(seen).toEqual([
      ['workflowGraph.judgeCheck.fallback.gap', undefined],
      [
        'workflowGraph.judgeCheck.checked',
        { count: 1, agree: 2, unsure: 3, fallback: 'it is listed as a gap' }
      ]
    ])
  })
})
