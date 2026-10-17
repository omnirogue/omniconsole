import { describe, expect, it } from 'vitest'
import { parseAskFromStatus, type AskPrompt } from './native-chat-ask'
import { buildGrokAskAnswerKeys } from './native-chat-grok-ask'

function ask(multiSelect = false): AskPrompt {
  return parseAskFromStatus(
    JSON.stringify({
      questions: [
        {
          question: 'Choose a marker',
          multiSelect,
          options: [{ label: 'First marker' }, { label: 'Second marker' }]
        }
      ]
    }),
    'ask_user_question'
  )!
}

const RESET_ROWS = [{ raw: '\x1b[A' }, { raw: '\x1b[A' }]

describe('Grok 1.0.34 native question keys', () => {
  it('selects the nondefault row before Enter instead of pasting an answer label', () => {
    expect(buildGrokAskAnswerKeys(ask(), [{ indices: [1] }])).toEqual([
      ...RESET_ROWS,
      { raw: '\x1b[B' },
      { raw: '\r' }
    ])
  })

  it('does not select a default without an explicit answer', () => {
    expect(buildGrokAskAnswerKeys(ask(), [{ indices: [] }])).toEqual([])
    expect(buildGrokAskAnswerKeys(ask(), [{ indices: [-1, 9] }])).toEqual([])
  })

  it('uses the documented Other editing shortcut before pasting custom text', () => {
    expect(buildGrokAskAnswerKeys(ask(), [{ indices: [], other: 'Custom marker' }])).toEqual([
      { raw: 'z' },
      { text: 'Custom marker' },
      { raw: '\r' }
    ])
  })

  it('toggles multi selections then confirms on the last selected row', () => {
    expect(buildGrokAskAnswerKeys(ask(true), [{ indices: [0, 1] }])).toEqual([
      ...RESET_ROWS,
      { raw: ' ' },
      { raw: '\x1b[B' },
      { raw: ' ' },
      { raw: '\r' }
    ])
  })

  it('submits on the last question without a separate Submit tab', () => {
    const prompt = { questions: [...ask().questions, ...ask().questions] }
    expect(buildGrokAskAnswerKeys(prompt, [{ indices: [1] }, { indices: [0] }])).toEqual([
      ...RESET_ROWS,
      { raw: '\x1b[B' },
      { raw: '\r' },
      ...RESET_ROWS,
      { raw: '\r' }
    ])
  })

  it('skips an unanswered question with Right before selecting the second question answer', () => {
    const prompt = { questions: [...ask().questions, ...ask().questions] }
    expect(buildGrokAskAnswerKeys(prompt, [{ indices: [] }, { indices: [1] }])).toEqual([
      { raw: '\x1b[C' },
      ...RESET_ROWS,
      { raw: '\x1b[B' },
      { raw: '\r' }
    ])
  })
})
