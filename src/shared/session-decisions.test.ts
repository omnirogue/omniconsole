import { describe, expect, it } from 'vitest'
import {
  answerAfterSessionEnded,
  decisionPriority,
  orderDecisions,
  scoreBand,
  type DecisionScores
} from './session-decisions'

const scores = (impact: number, effort: number): DecisionScores => ({
  impact,
  risk: 0.2,
  effort,
  model: 'jev-1.13.0',
  at: 0
})

describe('the Decisions box order', () => {
  it('puts the most value per second first, and the longest wait first at equal value', () => {
    const ordered = orderDecisions([
      { key: 'minor', askedAt: 1, scores: scores(0.25, 0) },
      { key: 'major-slow', askedAt: 2, scores: scores(0.75, 1) },
      { key: 'major-quick', askedAt: 3, scores: scores(0.75, 0) },
      { key: 'unscored-new', askedAt: 5, scores: null },
      { key: 'unscored-old', askedAt: 4, scores: null }
    ])
    // Why these ties: 0.75 × (1 − 0.5) and an unscored 0.5 × (1 − 0.25) are both 0.375.
    expect(ordered.map((decision) => decision.key)).toEqual([
      'major-quick',
      'major-slow',
      'unscored-old',
      'unscored-new',
      'minor'
    ])
  })

  it('reads an unscored decision as middling, never first or last by accident', () => {
    expect(decisionPriority({ scores: null })).toBe(0.375)
    expect(decisionPriority({ scores: scores(1, 0) })).toBe(1)
    expect(decisionPriority({ scores: scores(0, 0) })).toBe(0)
  })

  it('bands a reading for color only', () => {
    expect([scoreBand(0.2), scoreBand(0.35), scoreBand(0.6)]).toEqual(['low', 'medium', 'high'])
  })
})

describe('an answer after the session ended', () => {
  it('names each question with its answer so the resumed agent can carry on', () => {
    const text = answerAfterSessionEnded(
      [
        { question: 'Ship now?', multiSelect: false, options: [] },
        { question: 'Which region?', multiSelect: true, options: [] }
      ],
      'Yes\nUS, EU'
    )
    expect(text).toBe(
      [
        'You asked me this before your session ended, and I have answered it in OmniConsole:',
        '- "Ship now?" → Yes',
        '- "Which region?" → US, EU',
        'Carry on from where you stopped, using these answers.'
      ].join('\n')
    )
  })
})
