import { describe, expect, it } from 'vitest'
import { parseAskFromStatus, type AskPrompt } from './native-chat-ask'
import { buildOmpAskAnswerKeys } from './native-chat-omp-ask'

const RESET_ROWS = [{ raw: '\x1b[A' }, { raw: '\x1b[A' }, { raw: '\x1b[A' }]

function ask(multi = false, recommended = 0): AskPrompt {
  return parseAskFromStatus(
    JSON.stringify({
      questions: [
        {
          id: 'colors',
          question: 'Pick a color',
          multi,
          recommended,
          options: [{ label: 'Red' }, { label: 'Blue' }, { label: 'Green' }]
        }
      ]
    }),
    'ask'
  )!
}

describe('OMP 18.2 rich ask dialog keys', () => {
  it('moves to a nondefault answer before Enter instead of pasting its label', () => {
    expect(buildOmpAskAnswerKeys(ask(), [{ indices: [1] }])).toEqual([
      ...RESET_ROWS,
      { raw: '\x1b[B' },
      { raw: '\r' }
    ])
  })

  it('resets the native cursor instead of accepting its recommendation or prior navigation', () => {
    expect(buildOmpAskAnswerKeys(ask(false, 2), [{ indices: [0] }])).toEqual([
      ...RESET_ROWS,
      { raw: '\r' }
    ])
    expect(buildOmpAskAnswerKeys(ask(false, 2), [{ indices: [] }])).toEqual([])
  })

  it('toggles only the chosen multi options and submits once', () => {
    expect(buildOmpAskAnswerKeys(ask(true, 1), [{ indices: [0, 2] }])).toEqual([
      ...RESET_ROWS,
      { raw: ' ' },
      { raw: '\x1b[B' },
      { raw: '\x1b[B' },
      { raw: ' ' },
      { raw: '\r' }
    ])
  })

  it('opens Other before pasting a custom answer', () => {
    expect(buildOmpAskAnswerKeys(ask(false, 2), [{ indices: [], other: 'Purple' }])).toEqual([
      ...RESET_ROWS,
      { raw: '\x1b[B' },
      { raw: '\x1b[B' },
      { raw: '\x1b[B' },
      { raw: '\r' },
      { text: 'Purple' },
      { raw: '\r' }
    ])
  })

  it('keeps multi selections when adding Other and confirms its Submit tab', () => {
    expect(buildOmpAskAnswerKeys(ask(true, 2), [{ indices: [2], other: 'Purple' }])).toEqual([
      ...RESET_ROWS,
      { raw: '\x1b[B' },
      { raw: '\x1b[B' },
      { raw: ' ' },
      { raw: '\x1b[B' },
      { raw: '\r' },
      { text: 'Purple' },
      { raw: '\r' },
      { raw: '\r' }
    ])
  })

  it('advances each question and submits the native bundle exactly once', () => {
    const prompt = { questions: [...ask().questions, ...ask(false, 2).questions] }
    expect(buildOmpAskAnswerKeys(prompt, [{ indices: [1] }, { indices: [2] }])).toEqual([
      ...RESET_ROWS,
      { raw: '\x1b[B' },
      { raw: '\r' },
      ...RESET_ROWS,
      { raw: '\x1b[B' },
      { raw: '\x1b[B' },
      { raw: '\r' },
      { raw: '\r' }
    ])
  })

  it('does not commit the default for an invalid selection', () => {
    expect(buildOmpAskAnswerKeys(ask(), [{ indices: [-1, 99] }])).toEqual([])
  })
})
