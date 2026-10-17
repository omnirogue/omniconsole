import { describe, expect, it } from 'vitest'
import {
  resolveAskAnswerKeyAgent,
  shouldStepNativeChatAskAnswer
} from './native-chat-agent-support'
import { buildAgentAskAnswerKeys, resolveAskAnswerSurface } from './native-chat-ask-answer-keys'
import type { AskPrompt } from './native-chat-ask-types'
import { parseAskFromStatus } from './native-chat-ask'
import { serializeOptionOnlyAsk } from './native-chat-option-only-ask'

const SINGLE: AskPrompt = {
  questions: [{ question: 'q', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }]
}
const MULTI: AskPrompt = {
  questions: [{ question: 'q', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }]
}

describe('resolveAskAnswerKeyAgent', () => {
  it.each([
    ['claude', 'claude'],
    ['openclaude', 'claude'],
    ['claude-agent-teams', 'claude'],
    ['codex', 'codex'],
    ['omp', 'omp'],
    ['grok', 'grok'],
    ['gemini', 'gemini'],
    ['qwen-code', 'qwen'],
    ['hermes', 'hermes'],
    ['pi', null],
    ['kimi', null],
    ['cursor', null],
    [null, null]
  ])('%s → %s', (agent, expected) => {
    expect(resolveAskAnswerKeyAgent(agent)).toBe(expected)
  })

  it('steps selector answers for the new agents', () => {
    for (const agent of ['gemini', 'qwen-code', 'hermes']) {
      expect(shouldStepNativeChatAskAnswer(agent)).toBe(true)
      expect(shouldStepNativeChatAskAnswer(agent, { delivery: 'async' })).toBe(true)
    }
    expect(shouldStepNativeChatAskAnswer('pi')).toBe(false)
  })
})

describe('buildAgentAskAnswerKeys', () => {
  it.each([
    ['claude', [{ raw: '2' }]],
    ['codex', [{ raw: '2' }]],
    ['gemini', [{ raw: '2', screen: 0 }]],
    ['qwen', [{ raw: '2', screen: 0 }]],
    ['hermes', [{ raw: '2', screen: 0 }]]
  ] as const)('routes %s to its own builder', (agent, expected) => {
    expect(buildAgentAskAnswerKeys(agent, SINGLE, [{ indices: [1] }])).toEqual(expected)
  })

  it('returns nothing for a refused answer instead of a fallback', () => {
    expect(buildAgentAskAnswerKeys('gemini', MULTI, [{ indices: [1] }])).toEqual([])
    expect(buildAgentAskAnswerKeys('qwen', SINGLE, [{ indices: [0], other: 'x' }])).toEqual([])
  })
})

describe('resolveAskAnswerSurface', () => {
  it('keeps free text and skips for the existing selector agents', () => {
    expect(resolveAskAnswerSurface('claude', MULTI)).toEqual({
      allowOther: true,
      requireEveryAnswer: false,
      answerInTerminal: false
    })
  })

  it.each(['gemini', 'qwen-code', 'hermes'])(
    'offers %s options only, every question answered',
    (agent) => {
      expect(resolveAskAnswerSurface(agent, SINGLE)).toEqual({
        allowOther: false,
        requireEveryAnswer: true,
        answerInTerminal: false
      })
    }
  )

  it('sends a Gemini multi-select to the terminal but lets Qwen answer it', () => {
    expect(resolveAskAnswerSurface('gemini', MULTI).answerInTerminal).toBe(true)
    expect(resolveAskAnswerSurface('qwen-code', MULTI).answerInTerminal).toBe(false)
  })

  it('sends a question without options to the terminal', () => {
    const open: AskPrompt = { questions: [{ question: 'Why?', multiSelect: false, options: [] }] }
    expect(resolveAskAnswerSurface('qwen-code', open).answerInTerminal).toBe(true)
  })
})

describe('option-only envelopes never take the async message path', () => {
  const ocean = {
    question: 'Which ocean?',
    type: 'choice',
    options: [{ label: 'Atlantic' }, { label: 'Pacific' }]
  }

  it.each(['ask_user', 'ask_user_question', 'clarify'])(
    'ignores a stray asyncQuestions/delivery on %s',
    (tool) => {
      const input =
        tool === 'clarify'
          ? { question: 'Which ocean?', choices: ['Atlantic'], asyncQuestions: [ocean] }
          : { questions: [ocean], asyncQuestions: [ocean], delivery: 'async' }
      const prompt = parseAskFromStatus(serializeOptionOnlyAsk(input), tool)!
      expect(prompt.delivery).toBeUndefined()
      expect(prompt.questions[0]?.question).toBe('Which ocean?')
    }
  )

  it('steps these agents even for a prompt that claims async delivery', () => {
    for (const agent of ['gemini', 'qwen-code', 'hermes']) {
      expect(shouldStepNativeChatAskAnswer(agent, { delivery: 'async' })).toBe(true)
    }
    expect(shouldStepNativeChatAskAnswer('codex', { delivery: 'async' })).toBe(false)
  })
})
