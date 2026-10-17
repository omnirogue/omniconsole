import { describe, expect, it } from 'vitest'
import { agentQuestionAnswerTextRefusal } from '../runtime/agent-question-message-answer'
import { hookActivity } from './session-manage-hook-activity'
import { selectSessionAnswer } from './session-answer-selection'
import { readSessionAsyncQuestion } from './session-prompt-hook'

const PANE = { handle: 'term_1', ptyId: 'pty-1' }
const ASYNC = JSON.stringify({
  delivery: 'async',
  asyncQuestions: [
    {
      question: 'Which color do you prefer?',
      multiSelect: false,
      options: [{ label: 'Red' }, { label: 'Blue' }]
    }
  ]
})
const DONE = { state: 'done', interactivePrompt: ASYNC, stateStartedAt: 1_000 }

describe('omni session answer: Codex async questions', () => {
  it('reads a pending async question as a message-delivered prompt of its turn', () => {
    const prompt = readSessionAsyncQuestion(DONE, PANE)!
    expect(prompt.delivery).toEqual({
      kind: 'message',
      handle: 'term_1',
      ptyId: 'pty-1',
      askedAt: 1_000
    })
    expect(prompt.options.map((option) => [option.n, option.label, option.value])).toEqual([
      [1, 'Red', '> Which color do you prefer?\n\nRed'],
      [2, 'Blue', '> Which color do you prefer?\n\nBlue']
    ])
    expect(prompt.ask.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('reads none while the turn runs, or while a child holds the pane', () => {
    expect(readSessionAsyncQuestion({ ...DONE, state: 'working' }, PANE)).toBeNull()
    expect(readSessionAsyncQuestion({ ...DONE, state: 'waiting' }, PANE)).toBeNull()
    expect(
      readSessionAsyncQuestion({ ...DONE, state: 'working', workingMode: 'monitoring' }, PANE)
    ).not.toBeNull()
  })

  it('leaves selector questions and multi-question asks to their own paths', () => {
    const selector = JSON.stringify({
      questions: [{ question: 'Ship?', options: [{ label: 'Yes' }] }]
    })
    const two = JSON.stringify({
      delivery: 'async',
      asyncQuestions: [
        { question: 'A?', multiSelect: false, options: [] },
        { question: 'B?', multiSelect: false, options: [] }
      ]
    })
    expect(readSessionAsyncQuestion({ ...DONE, interactivePrompt: selector }, PANE)).toBeNull()
    expect(readSessionAsyncQuestion({ ...DONE, interactivePrompt: two }, PANE)).toBeNull()
  })

  it('answers with the option or with marked free text, in the reply layout', () => {
    const prompt = readSessionAsyncQuestion(DONE, PANE)!
    expect(selectSessionAnswer(prompt, { kind: 'choose', choice: 2 }, { kind: 'cli' }).value).toBe(
      '> Which color do you prefer?\n\nBlue'
    )
    const text = selectSessionAnswer(prompt, { kind: 'text', text: 'Teal' }, { kind: 'cli' })
    expect(text.value).toMatch(/^> Which color do you prefer\?\n\n\[from .+\] Teal$/)
  })

  it('refuses empty, oversized and control-character answers (C1 included) up front', () => {
    expect(agentQuestionAnswerTextRefusal('> Q\n\nBlue')).toBeNull()
    expect(agentQuestionAnswerTextRefusal('  ')).toMatch(/empty/)
    expect(agentQuestionAnswerTextRefusal('x'.repeat(32_001))).toMatch(/longer/)
    expect(agentQuestionAnswerTextRefusal('Blue\x1b[A')).toMatch(/control/)
    expect(agentQuestionAnswerTextRefusal('Blue\u009b2J')).toMatch(/control/)
  })

  it('is awaiting-user while only children run, as `session questions` lists it', () => {
    expect(
      hookActivity({
        state: 'working',
        workingMode: 'monitoring',
        interactivePrompt: ASYNC,
        updatedAt: 1
      })
    ).toMatchObject({ kind: 'question' })
    expect(hookActivity({ state: 'working', interactivePrompt: ASYNC, updatedAt: 1 })).toEqual({
      kind: 'working'
    })
  })
})
