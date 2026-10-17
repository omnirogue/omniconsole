import { describe, expect, it } from 'vitest'
import { parseAskFromStatus } from './native-chat-ask'
import { buildHermesAskAnswerKeys, parseHermesClarify } from './native-chat-hermes-ask'

// Hermes Agent v0.21.5 clarify args (tools/clarify_tool.py), forwarded as tool_input.
const HERMES_SINGLE = {
  question: 'Which fruit?',
  choices: ['Apple', 'Banana', 'Cherry'],
  multi_select: true
}
const HERMES_BATCH = {
  questions: [
    { id: 'ocean', question: 'Which ocean?', choices: ['Atlantic', 'Pacific'] },
    { id: 'color', question: 'Which color?', choices: ['Red', 'Blue'], multi_select: true }
  ]
}

describe('parseHermesClarify', () => {
  it('maps one question and forces single-select (the TUI ignores multi_select)', () => {
    expect(parseAskFromStatus(JSON.stringify(HERMES_SINGLE), 'clarify')).toEqual({
      questions: [
        {
          question: 'Which fruit?',
          multiSelect: false,
          options: [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }]
        }
      ]
    })
  })

  it('maps a batch in order, every question single-select', () => {
    expect(parseHermesClarify(HERMES_BATCH)).toEqual({
      questions: [
        {
          question: 'Which ocean?',
          multiSelect: false,
          options: [{ label: 'Atlantic' }, { label: 'Pacific' }]
        },
        {
          question: 'Which color?',
          multiSelect: false,
          options: [{ label: 'Red' }, { label: 'Blue' }]
        }
      ]
    })
  })

  it('caps choices at 4 like Hermes MAX_CHOICES', () => {
    const prompt = parseHermesClarify({ question: 'Pick', choices: ['a', 'b', 'c', 'd', 'e'] })
    expect(prompt?.questions[0]?.options.map((option) => option.label)).toEqual([
      'a',
      'b',
      'c',
      'd'
    ])
  })

  it.each([
    ['an open-ended question', { question: 'Why?' }],
    ['empty choices', { question: 'Why?', choices: [] }],
    [
      'a batch with one open-ended question',
      { questions: [HERMES_BATCH.questions[0], { question: 'Why?' }] }
    ],
    ['a blank choice that would shift digits', { question: 'Pick', choices: ['a', ' ', 'b'] }],
    ['an empty batch', { questions: [] }],
    [
      'more questions than Hermes allows',
      { questions: Array.from({ length: 6 }, () => ({ question: 'q', choices: ['a'] })) }
    ]
  ])('refuses %s (no card; the pane keeps waiting)', (_label, input) => {
    expect(parseHermesClarify(input)).toBeNull()
    expect(parseAskFromStatus(JSON.stringify(input), 'clarify')).toBeNull()
  })
})

describe('buildHermesAskAnswerKeys', () => {
  const lone = parseHermesClarify(HERMES_SINGLE)!
  const batch = parseHermesClarify(HERMES_BATCH)!

  it('picks and submits a lone question with its digit', () => {
    expect(buildHermesAskAnswerKeys(lone, [{ indices: [2] }])).toEqual([{ raw: '3', screen: 0 }])
  })

  it('answers a batch with one digit per question and no Enter', () => {
    expect(buildHermesAskAnswerKeys(batch, [{ indices: [1] }, { indices: [0] }])).toEqual([
      { raw: '2', screen: 0 },
      { raw: '1', screen: 1 }
    ])
  })

  it.each([
    ['an unanswered question', batch, [{ indices: [1] }, { indices: [] }]],
    ['free text', lone, [{ indices: [0], other: 'Mango' }]],
    ['two picks', lone, [{ indices: [0, 1] }]],
    ['an index out of range', lone, [{ indices: [3] }]],
    [
      'a multi-select question',
      { questions: [{ ...lone.questions[0]!, multiSelect: true }] },
      [{ indices: [0] }]
    ]
  ])('refuses %s', (_label, prompt, selections) => {
    expect(buildHermesAskAnswerKeys(prompt, selections)).toEqual([])
  })
})
