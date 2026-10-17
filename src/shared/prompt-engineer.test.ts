import { describe, expect, it } from 'vitest'
import {
  parseEngineeredPrompt,
  promptEngineerChatInput,
  promptEngineerGoInput,
  promptEngineerInput,
  PROMPT_ENGINEER_INSTRUCTION
} from './prompt-engineer'

describe('prompt engineering draft contract', () => {
  it.each([
    'a) Revised prompt\nBuild a page.\nb) Questions\nWhich audience?',
    '## Revised Prompt\nBuild a page.\n## Questions\nWhich audience?',
    '**Revised prompt:**\nBuild a page.\n**Questions:**\nWhich audience?',
    'Revised prompt:\n```text\nBuild a page.\n```\nQuestions:\nWhich audience?'
  ])('extracts only the prompt from existing LLM section formatting', (reply) => {
    expect(parseEngineeredPrompt(reply)).toEqual({
      revised: 'Build a page.',
      questions: 'Which audience?'
    })
  })
  it('refuses incomplete responses instead of launching raw commentary', () => {
    expect(parseEngineeredPrompt('I can build a page.')).toBeNull()
    expect(parseEngineeredPrompt('Revised prompt:\n\nQuestions:\nWhat?')).toBeNull()
  })
  it('uses the supplied instruction as an ordinary drafting request with iteration context', () => {
    const prompt = promptEngineerInput([
      { role: 'user', text: 'Build a page' },
      { role: 'assistant', text: 'Revised prompt:\nBuild a page.\nQuestions:\nWho?' },
      { role: 'user', text: 'For students' }
    ])
    expect(prompt.startsWith(PROMPT_ENGINEER_INSTRUCTION)).toBe(true)
    expect(prompt).toContain('do not execute the task')
    expect(prompt).toContain('For students')
  })
})

it('keeps refinement separate from explicit Go and includes final edits', () => {
  expect(promptEngineerChatInput('Make a page')).toContain(
    'do not execute the task until I press Go'
  )
  expect(promptEngineerGoInput('Make it blue')).toContain('Apply these final changes')
  expect(promptEngineerGoInput('Make it blue')).toContain('Make it blue')
  expect(promptEngineerGoInput('')).toContain('If no revised prompt has been produced')
})
