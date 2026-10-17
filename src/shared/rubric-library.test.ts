import { describe, expect, it } from 'vitest'
import { jevCriteria } from './jev-rubric'
import { normalizeSavedReviewRubrics, REVIEW_RUBRIC_PRESETS } from './review-rubrics'
import { isRubricKind } from './rubric-kinds'
import { LIBRARY_RUBRICS, readRubricsFile, rubricLibrary, rubricsFile } from './rubric-library'

describe('the rubric library', () => {
  it('ships starters JEV scores line by line, one name each', () => {
    expect(new Set(LIBRARY_RUBRICS.map((entry) => entry.name)).size).toBe(LIBRARY_RUBRICS.length)
    for (const entry of LIBRARY_RUBRICS) {
      const criteria = jevCriteria(entry.instructions)
      expect(criteria.length, entry.name).toBeGreaterThanOrEqual(3)
      expect(
        criteria.every((criterion) => /^c\d+$/.test(criterion.id)),
        entry.name
      ).toBe(true)
      expect(isRubricKind(entry.kind)).toBe(true)
    }
  })

  it('words former prohibitions as properties, since JEV misreads negated criteria', () => {
    const questions = LIBRARY_RUBRICS.flatMap((entry) =>
      jevCriteria(entry.instructions).map((criterion) => criterion.question)
    )
    expect(questions).toEqual(
      expect.arrayContaining([
        'Every claim is backed by the facts given',
        'Every element on it supports that one next step',
        'Every refund, cancellation or change it mentions has already been done, or it says plainly that it is still pending',
        'It handles edge cases and failures explicitly, surfacing every error',
        'It keeps data and security intact',
        'Its content is correct and every fact is supported by the input'
      ])
    )
    expect(questions.filter((question) => /\b(?:never|no)\b/i.test(question))).toEqual([])
  })

  it('lists the review presets, the starters, then the rubrics the person saved', () => {
    const library = rubricLibrary([
      { name: 'Our ads', instructions: '- Short\n- Honest', kind: 'ads' },
      { name: 'Old one', instructions: 'Judge it.' }
    ])
    expect(library.slice(0, REVIEW_RUBRIC_PRESETS.length).map((entry) => entry.value)).toEqual(
      REVIEW_RUBRIC_PRESETS.map((preset) => preset.id)
    )
    expect(library.find((entry) => entry.rubric.name === 'Ad copy')).toMatchObject({
      value: 'library:ad-copy',
      kind: 'ads',
      builtIn: true,
      rubric: { id: 'custom' }
    })
    expect(library.slice(-2)).toEqual([
      expect.objectContaining({ value: 'saved:Our ads', kind: 'ads', builtIn: false }),
      expect.objectContaining({ value: 'saved:Old one', kind: 'other', builtIn: false })
    ])
  })

  it('keeps what a saved rubric judges, and drops a kind it does not know', () => {
    expect(
      normalizeSavedReviewRubrics([
        { name: 'A', instructions: 'x', kind: 'repo' },
        { name: 'B', instructions: 'y', kind: 'nonsense' }
      ])
    ).toEqual([
      { name: 'A', instructions: 'x', kind: 'repo' },
      { name: 'B', instructions: 'y' }
    ])
  })

  it('shares rubrics as a file the team imports, and refuses files it cannot use', () => {
    const saved = [
      { name: 'Our ads', instructions: '- Short\n- Honest', kind: 'ads' as const },
      { name: 'Plain', instructions: 'Judge the whole.' }
    ]
    expect(readRubricsFile(rubricsFile(saved))).toEqual([saved[0], { ...saved[1], kind: 'other' }])
    expect(readRubricsFile('not json')).toEqual({
      error: 'This file is not a rubrics file: it is not valid JSON.'
    })
    expect(readRubricsFile('{"rubrics": []}')).toEqual({
      error: 'This file is not an OmniConsole rubrics file.'
    })
    expect(
      readRubricsFile('{"format": "omni-rubrics", "version": 1, "rubrics": [{"name": ""}]}')
    ).toEqual({ error: 'The file has no rubrics that can be used.' })
  })
})
