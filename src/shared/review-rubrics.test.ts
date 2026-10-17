import { describe, expect, it } from 'vitest'
import {
  composeReviewStepInstructions,
  expandReviewRubricInstructions,
  normalizeReviewRubric,
  parseReviewStepInstructions,
  reviewerStepInstructions,
  normalizeSavedReviewRubrics,
  REVIEW_RUBRIC_MAX_CHARS,
  REVIEW_RUBRIC_PRESETS
} from './review-rubrics'

describe('review rubrics', () => {
  it('ships four presets, each saying what blocks and what does not', () => {
    expect(REVIEW_RUBRIC_PRESETS.map((preset) => preset.id)).toEqual([
      'general',
      'reliability',
      'design',
      'outcome'
    ])
    for (const preset of REVIEW_RUBRIC_PRESETS) {
      expect(preset.instructions).toContain('Blocker:')
      expect(preset.instructions).toContain('Not a blocker:')
    }
  })

  it('keeps a valid rubric and refuses an unknown id, empty text or oversize text', () => {
    expect(
      normalizeReviewRubric({ id: 'design', name: ' Design ', instructions: ' Judge. ' })
    ).toEqual({ id: 'design', name: 'Design', instructions: 'Judge.' })
    expect(normalizeReviewRubric({ id: 'vibes', name: 'x', instructions: 'y' })).toBeUndefined()
    expect(normalizeReviewRubric({ id: 'custom', name: 'x', instructions: '  ' })).toBeUndefined()
    expect(
      normalizeReviewRubric({
        id: 'custom',
        name: 'x',
        instructions: 'y'.repeat(REVIEW_RUBRIC_MAX_CHARS + 1)
      })
    ).toBeUndefined()
  })

  it('saves named rubrics once per name and drops invalid entries', () => {
    expect(
      normalizeSavedReviewRubrics([
        { name: 'Brand voice', instructions: 'Match the style guide.' },
        { name: 'brand VOICE', instructions: 'Duplicate name.' },
        { name: '', instructions: 'No name.' },
        'not a rubric'
      ])
    ).toEqual([{ name: 'Brand voice', instructions: 'Match the style guide.' }])
    expect(normalizeSavedReviewRubrics(undefined)).toEqual([])
  })

  it('round-trips a shared rubric, per-reviewer rubrics and a focus', () => {
    const [general, , design] = REVIEW_RUBRIC_PRESETS
    const custom = { id: 'custom' as const, name: 'Brand voice', instructions: 'Match the guide.' }
    const value = {
      shared: general!,
      perReviewer: [design!, undefined, custom],
      focus: 'Check the settings page.'
    }
    const text = composeReviewStepInstructions(value)
    expect(text.startsWith('Rubric: General\n')).toBe(true)
    expect(parseReviewStepInstructions(text)).toEqual(value)
    expect(parseReviewStepInstructions('Look at edge cases.')).toEqual({
      perReviewer: [],
      focus: 'Look at edge cases.'
    })
    expect(composeReviewStepInstructions({ perReviewer: [], focus: 'as typed ' })).toBe('as typed ')
    // Each seat is asked about its own rubric, or the step's when it has none.
    expect(reviewerStepInstructions(text, 0)).toBe(
      composeReviewStepInstructions({ shared: design!, perReviewer: [], focus: value.focus })
    )
    expect(reviewerStepInstructions(text, 1)).toContain('Rubric: General')
    expect(reviewerStepInstructions(text, 2)).toContain('Rubric: Brand voice')
    expect(reviewerStepInstructions('Plain focus.', 1)).toBe('Plain focus.')
  })

  it('keeps text exactly as typed through the round trip, trailing space and newlines included', () => {
    const custom = { id: 'custom' as const, name: 'Voice', instructions: 'Line one\nline two ' }
    const value = { perReviewer: [custom, custom], focus: 'Focus with a trailing newline\n' }
    expect(parseReviewStepInstructions(composeReviewStepInstructions(value))).toEqual(value)
  })

  it('expands rubrics a chat plan names without their text', () => {
    const [, reliability, design] = REVIEW_RUBRIC_PRESETS
    expect(expandReviewRubricInstructions('Rubric: design quality')).toBe(
      composeReviewStepInstructions({ shared: design!, perReviewer: [], focus: '' })
    )
    expect(
      expandReviewRubricInstructions(
        'Rubric (reviewer 1): Design quality\n\nRubric (reviewer 2): reliability\n\nReview focus:\nThe parser.'
      )
    ).toBe(
      composeReviewStepInstructions({ perReviewer: [design!, reliability!], focus: 'The parser.' })
    )
    expect(expandReviewRubricInstructions('Plain focus.')).toBe('Plain focus.')
  })
})
