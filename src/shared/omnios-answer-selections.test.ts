import { describe, expect, it } from 'vitest'
import { omniosAnswerSelections } from './omnios-answer-selections'
import { buildAskAnswerKeys, formatAskAnswer, hasAskAnswer } from './native-chat-ask'
import type { AskPrompt } from './native-chat-ask-types'

// Sal's real card: four questions, one multi-select, one free text, one skipped.
const CARD: AskPrompt = {
  questions: [
    {
      question: 'How deep should the review go?',
      header: 'Depth',
      multiSelect: false,
      options: [{ label: 'Quick pass' }, { label: 'Full audit' }]
    },
    {
      question: 'Which URLs should be checked?',
      header: 'URLs',
      multiSelect: false,
      options: [{ label: 'Production only' }, { label: 'Staging only' }]
    },
    {
      question: 'Which PR links should be included?',
      header: 'PR links',
      multiSelect: true,
      options: [{ label: 'Open PRs' }, { label: 'Merged, last week' }, { label: 'Drafts' }]
    },
    {
      question: 'Should Stripe be touched?',
      header: 'Stripe',
      multiSelect: false,
      options: [{ label: 'Yes' }, { label: 'No' }]
    }
  ]
}

describe('omniosAnswerSelections', () => {
  it('maps a 4-question answer with multi-select, free text and a skipped question', () => {
    const selections = omniosAnswerSelections(CARD, {
      'How deep should the review go?': 'Full audit',
      'Which URLs should be checked?': 'https://a.example and https://b.example',
      'Which PR links should be included?': 'Open PRs, Merged, last week'
    })
    expect(selections).toEqual([
      { indices: [1] },
      { indices: [], other: 'https://a.example and https://b.example' },
      { indices: [0, 1] },
      { indices: [] }
    ])
    expect(hasAskAnswer(CARD, selections)).toBe(true)
    expect(formatAskAnswer(CARD, selections)).toBe(
      'Full audit\nhttps://a.example and https://b.example\nOpen PRs, Merged, last week\n'
    )
    // Every question is driven: digit picks, the free-text row, two toggles, a skip, then Submit.
    const keys = buildAskAnswerKeys(CARD, selections)
    expect(keys.filter((group) => 'text' in group)).toEqual([
      { text: 'https://a.example and https://b.example' }
    ])
    expect(keys.map((group) => ('raw' in group ? group.raw : 'TEXT'))).toContain('2')
    expect(keys.at(-1)).toMatchObject({ raw: '\r' })
  })

  it('keeps multi-line free text on one line so Enter cannot submit it early', () => {
    const selections = omniosAnswerSelections(CARD, {
      'Which URLs should be checked?': 'https://a.example\n  https://b.example\n'
    })
    expect(selections[1]).toEqual({ indices: [], other: 'https://a.example https://b.example' })
  })

  it('matches by header, ignores case and spacing, and reads new-line separated multi-select', () => {
    expect(
      omniosAnswerSelections(CARD, {
        depth: '  quick   PASS ',
        'PR links': 'drafts\nopen prs',
        Stripe: 'No'
      })
    ).toEqual([{ indices: [0] }, { indices: [] }, { indices: [0, 2] }, { indices: [1] }])
  })

  it('keeps unmatched multi-select text as the free-text answer after picked labels', () => {
    expect(
      omniosAnswerSelections(CARD, { 'Which PR links should be included?': 'Drafts, #482 too' })[2]
    ).toEqual({ indices: [2], other: '#482 too' })
    expect(
      omniosAnswerSelections(CARD, { 'Which PR links should be included?': 'Merged' })[2]
    ).toEqual({ indices: [], other: 'Merged' })
  })

  it('treats a missing or blank answer as skipping that question', () => {
    const selections = omniosAnswerSelections(CARD, { 'Should Stripe be touched?': '   ' })
    expect(selections.every((selection) => selection.indices.length === 0)).toBe(true)
    expect(hasAskAnswer(CARD, selections)).toBe(false)
  })

  it('takes a lone answer for a single-question prompt whatever its key', () => {
    const prompt: AskPrompt = { questions: [CARD.questions[3]] }
    expect(omniosAnswerSelections(prompt, { anything: 'yes' })).toEqual([{ indices: [0] }])
  })
})
