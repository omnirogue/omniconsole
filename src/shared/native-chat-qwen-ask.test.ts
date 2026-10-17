import { describe, expect, it } from 'vitest'
import { parseAskFromStatus } from './native-chat-ask'
import { buildQwenAskAnswerKeys } from './native-chat-qwen-ask'

// Verbatim PermissionRequest tool_input from Qwen Code 0.22.3 (live, 27 Sep 2026).
const QWEN_BATCH = {
  questions: [
    {
      question: 'Which ocean?',
      header: 'Ocean',
      options: [
        { label: 'Atlantic', description: 'East' },
        { label: 'Pacific', description: 'West' }
      ]
    },
    {
      question: 'Which colors?',
      header: 'Colors',
      options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }],
      multiSelect: true
    }
  ]
}
const QWEN_LONE_MULTI = { questions: [QWEN_BATCH.questions[1]] }
const QWEN_LONE_SINGLE = {
  questions: [
    {
      question: 'Which fruit?',
      header: 'Fruit',
      options: [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }]
    }
  ]
}

const parse = (input: unknown) => parseAskFromStatus(JSON.stringify(input), 'ask_user_question')!

describe('Qwen ask_user_question parsing', () => {
  it('parses the live batch through the canonical shape', () => {
    expect(parse(QWEN_BATCH)).toMatchObject({
      questions: [
        { question: 'Which ocean?', header: 'Ocean', multiSelect: false },
        { question: 'Which colors?', header: 'Colors', multiSelect: true }
      ]
    })
  })
})

describe('buildQwenAskAnswerKeys', () => {
  it('picks a lone single-select with its digit alone (it submits)', () => {
    expect(buildQwenAskAnswerKeys(parse(QWEN_LONE_SINGLE), [{ indices: [2] }])).toEqual([
      { raw: '3', screen: 0 }
    ])
  })

  it('answers a batch of two singles with digits then one Enter on Submit', () => {
    const prompt = {
      questions: [parse(QWEN_BATCH).questions[0]!, parse(QWEN_LONE_SINGLE).questions[0]!]
    }
    expect(buildQwenAskAnswerKeys(prompt, [{ indices: [1] }, { indices: [0] }])).toEqual([
      { raw: '2', screen: 0 },
      { raw: '1', screen: 1 },
      { raw: '\r', screen: 'submit' }
    ])
  })

  it('moves, toggles and confirms a lone multi-select; its Enter submits', () => {
    expect(buildQwenAskAnswerKeys(parse(QWEN_LONE_MULTI), [{ indices: [2, 1] }])).toEqual([
      { raw: '2', screen: 0 },
      { raw: ' ', screen: 0 },
      { raw: '3', screen: 0 },
      { raw: ' ', screen: 0 },
      { raw: '\r', screen: 0 }
    ])
  })

  it('confirms a multi-select in a batch, then submits once', () => {
    expect(
      buildQwenAskAnswerKeys(parse(QWEN_BATCH), [{ indices: [1] }, { indices: [0, 2] }])
    ).toEqual([
      { raw: '2', screen: 0 },
      { raw: '1', screen: 1 },
      { raw: ' ', screen: 1 },
      { raw: '3', screen: 1 },
      { raw: ' ', screen: 1 },
      { raw: '\r', screen: 1 },
      { raw: '\r', screen: 'submit' }
    ])
  })

  it.each([
    ['an unanswered question', QWEN_BATCH, [{ indices: [1] }, { indices: [] }]],
    ['a multi-select with nothing ticked', QWEN_LONE_MULTI, [{ indices: [] }]],
    ['free text', QWEN_LONE_SINGLE, [{ indices: [0], other: 'Mango' }]],
    ['free text on a multi-select', QWEN_LONE_MULTI, [{ indices: [0], other: 'Pink' }]],
    ['two picks on a single-select', QWEN_LONE_SINGLE, [{ indices: [0, 1] }]],
    ['an index out of range', QWEN_LONE_SINGLE, [{ indices: [3] }]],
    ['an out-of-range multi pick', QWEN_LONE_MULTI, [{ indices: [0, 3] }]]
  ])('refuses %s', (_label, input, selections) => {
    expect(buildQwenAskAnswerKeys(parse(input), selections)).toEqual([])
  })
})
