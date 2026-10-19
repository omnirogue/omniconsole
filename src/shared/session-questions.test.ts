import { describe, expect, it } from 'vitest'
import { pendingSessionAsk, sessionQuestionSummary } from './session-questions'
import { normalizeSessionQuestionsSettings } from './session-questions-settings'

const ASK = JSON.stringify({
  questions: [
    { question: 'Ship now?', multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] },
    { question: 'Which env?', multiSelect: true, options: [{ label: 'dev' }, { label: 'prod' }] }
  ]
})

describe('pending session questions', () => {
  it('reads a question the pane waits on, and nothing once it works again or asks for approval', () => {
    const ask = pendingSessionAsk({
      state: 'waiting',
      interactivePrompt: ASK,
      toolName: 'AskUserQuestion'
    })
    expect(ask?.questions.map((question) => question.question)).toEqual(['Ship now?', 'Which env?'])
    expect(sessionQuestionSummary(ask!)).toBe('Ship now? (+1 more)')
    expect(pendingSessionAsk({ state: 'working', interactivePrompt: ASK })).toBeNull()
    expect(pendingSessionAsk({ state: 'waiting', interactivePrompt: undefined })).toBeNull()
    expect(
      pendingSessionAsk({
        state: 'blocked',
        interactivePrompt: JSON.stringify({ approval: { tool: 'Bash', summary: 'ls' } }),
        toolName: 'Bash'
      })
    ).toBeNull()
  })

  it('ships the inline answers on, off only when switched off', () => {
    expect(normalizeSessionQuestionsSettings(undefined)).toEqual({
      inlineAnswers: true,
      turnEndQuestions: false
    })
    expect(normalizeSessionQuestionsSettings({ inlineAnswers: 'no' })).toEqual({
      inlineAnswers: true,
      turnEndQuestions: false
    })
    expect(normalizeSessionQuestionsSettings({ inlineAnswers: false })).toEqual({
      inlineAnswers: false,
      turnEndQuestions: false
    })
  })

  it('ships turn-end questions off, on only when switched on', () => {
    expect(normalizeSessionQuestionsSettings(undefined).turnEndQuestions).toBe(false)
    expect(normalizeSessionQuestionsSettings({ turnEndQuestions: 'yes' }).turnEndQuestions).toBe(
      false
    )
    expect(normalizeSessionQuestionsSettings({ turnEndQuestions: true }).turnEndQuestions).toBe(
      true
    )
  })
})
