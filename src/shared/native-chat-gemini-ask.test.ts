import { describe, expect, it } from 'vitest'
import { parseAskFromStatus } from './native-chat-ask'
import { buildGeminiAskAnswerKeys, parseGeminiAskUser } from './native-chat-gemini-ask'
import type { AskPrompt } from './native-chat-ask-types'

// Verbatim BeforeTool tool_input from Gemini CLI 0.61.0 (live, 27 Sep 2026).
const GEMINI_BATCH = {
  questions: [
    {
      question: 'Which ocean?',
      type: 'choice',
      header: 'Ocean',
      options: [
        { label: 'Atlantic', description: 'East' },
        { label: 'Pacific', description: 'West' }
      ],
      multiSelect: false
    },
    {
      question: 'Which colors?',
      type: 'choice',
      header: 'Colors',
      options: [{ label: 'Red' }, { label: 'Blue' }, { label: 'Green' }],
      multiSelect: true
    }
  ]
}

const single = (question: string, labels: string[]) => ({
  question,
  multiSelect: false,
  options: labels.map((label) => ({ label }))
})

describe('parseGeminiAskUser', () => {
  it('parses the live ask_user batch, keeping multi-select', () => {
    expect(parseAskFromStatus(JSON.stringify(GEMINI_BATCH), 'ask_user')).toEqual({
      questions: [
        {
          question: 'Which ocean?',
          header: 'Ocean',
          multiSelect: false,
          options: [
            { label: 'Atlantic', description: 'East' },
            { label: 'Pacific', description: 'West' }
          ]
        },
        {
          question: 'Which colors?',
          header: 'Colors',
          multiSelect: true,
          options: [
            { label: 'Red', description: undefined },
            { label: 'Blue', description: undefined },
            { label: 'Green', description: undefined }
          ]
        }
      ]
    })
  })

  it('keeps a question’s placeholder for the custom-row check', () => {
    expect(
      parseGeminiAskUser({
        questions: [{ question: 'Pick', options: [{ label: 'A' }], placeholder: 'Other fruit' }]
      })?.questions[0]?.placeholder
    ).toBe('Other fruit')
  })

  it('accepts a question with no type', () => {
    expect(
      parseGeminiAskUser({ questions: [{ question: 'Pick', options: [{ label: 'A' }] }] })
    ).toMatchObject({ questions: [{ question: 'Pick', multiSelect: false }] })
  })

  it.each([
    ['a text question', { questions: [{ question: 'Name?', type: 'text' }] }],
    ['a yesno question', { questions: [{ question: 'Ok?', type: 'yesno', options: [] }] }],
    [
      'a batch with one non-choice question',
      { questions: [GEMINI_BATCH.questions[0], { question: 'Why?', type: 'text' }] }
    ],
    ['a choice without options', { questions: [{ question: 'Pick', type: 'choice' }] }],
    ['no questions', { questions: [] }]
  ])('refuses %s (no card; the pane keeps waiting)', (_label, input) => {
    expect(parseGeminiAskUser(input)).toBeNull()
    // Why: the canonical fallback must not resurrect a card for a refused ask_user.
    expect(parseAskFromStatus(JSON.stringify(input), 'ask_user')).toBeNull()
  })
})

describe('buildGeminiAskAnswerKeys', () => {
  const lone: AskPrompt = { questions: [single('Fruit?', ['Apple', 'Banana', 'Cherry'])] }
  const pair: AskPrompt = {
    questions: [single('Ocean?', ['Atlantic', 'Pacific']), single('Color?', ['Red', 'Blue'])]
  }

  it('picks a lone single-select with its digit alone', () => {
    expect(buildGeminiAskAnswerKeys(lone, [{ indices: [2] }])).toEqual([{ raw: '3', screen: 0 }])
  })

  it('answers a batch with one digit per question then Enter on Review', () => {
    expect(buildGeminiAskAnswerKeys(pair, [{ indices: [1] }, { indices: [0] }])).toEqual([
      { raw: '2', screen: 0 },
      { raw: '1', screen: 1 },
      { raw: '\r', screen: 'submit' }
    ])
  })

  it.each([
    ['an unanswered question', pair, [{ indices: [1] }, { indices: [] }]],
    ['a missing selection', pair, [{ indices: [1] }]],
    ['free text', lone, [{ indices: [0], other: 'Mango' }]],
    ['free text alone', lone, [{ indices: [], other: 'Mango' }]],
    ['two picks on a single-select', lone, [{ indices: [0, 1] }]],
    ['an index out of range', lone, [{ indices: [3] }]],
    ['a negative index', lone, [{ indices: [-1] }]],
    [
      'any multi-select question',
      parseGeminiAskUser(GEMINI_BATCH)!,
      [{ indices: [1] }, { indices: [0] }]
    ]
  ])('refuses %s', (_label, prompt, selections) => {
    expect(buildGeminiAskAnswerKeys(prompt, selections)).toEqual([])
  })

  it('refuses an option a single digit cannot address', () => {
    const labels = Array.from({ length: 10 }, (_, i) => `O${i + 1}`)
    expect(
      buildGeminiAskAnswerKeys({ questions: [single('Many', labels)] }, [{ indices: [9] }])
    ).toEqual([])
  })
})
