import { describe, expect, it, vi } from 'vitest'
import { workflowErrorText, workflowErrorWasTranslated } from './workflow-error-text'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string) => english
}))

/**
 * Why these tests exist: live acceptance showed raw codes such as `agent_prompt_stalled` on the
 * main path. People read plain words; the raw report stays one click away in Details.
 */
describe('workflowErrorText', () => {
  it('gives known codes plain words, even behind a role prefix', () => {
    expect(workflowErrorText('agent_prompt_stalled')).toBe(
      'The agent stopped responding before it started the task.'
    )
    expect(workflowErrorText('builder: agent_prompt_stalled')).toBe(
      'The agent stopped responding before it started the task.'
    )
    expect(workflowErrorText('Agent startup blocked: codex-hooks-review-prompt')).toMatch(
      /^Codex wants its hooks reviewed/
    )
    expect(workflowErrorText('answer never matched its schema: missing ranking')).toBe(
      "The agent's answer was not in the expected format."
    )
  })

  it('never shows an unknown bare code, and keeps the host sentences people can read', () => {
    expect(workflowErrorText('worker_exit_unclean')).toBe(
      'The agent stopped unexpectedly. Details has the full report.'
    )
    expect(workflowErrorText('timed out after 15:00')).toBe('timed out after 15:00')
    expect(workflowErrorText('  Codex account is locked ')).toBe('Codex account is locked')
  })

  it('words an unknown code for where it is read', () => {
    // Why: on the run itself "the agent" may be wrong, and inside Details the code is the report.
    expect(workflowErrorText('worker_exit_unclean', 'run')).toBe(
      'The run stopped unexpectedly. Details has the full report.'
    )
    expect(workflowErrorText('worker_exit_unclean', 'details')).toBe('worker_exit_unclean')
    expect(workflowErrorText('agent_prompt_stalled', 'details')).toBe(
      'The agent stopped responding before it started the task.'
    )
  })

  it('says when Details should also show the original report', () => {
    expect(workflowErrorWasTranslated('agent_prompt_stalled')).toBe(true)
    expect(workflowErrorWasTranslated('timed out after 15:00')).toBe(false)
  })
})
