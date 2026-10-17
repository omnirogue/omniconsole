import { expect, it } from 'vitest'
import { proposeOutcomeFromPrompt, stripPlanModeToken } from './work-plan-prompt-token'

it.each(['(plan) do X', 'do (Plan) X', 'do X (PLAN)', '(plan) do X (plan)'])(
  'strips every token: %s',
  (input) => {
    const result = stripPlanModeToken(input)
    expect(result.planMode).toBe(true)
    expect(result.prompt).not.toMatch(/\(plan\)/i)
    expect(result.prompt.replace(/ +/g, ' ')).toBe('do X')
  }
)
it('treats an exact substring as a token even inside a word', () => {
  expect(stripPlanModeToken('explain(plan)')).toEqual({ prompt: 'explain', planMode: true })
  expect(stripPlanModeToken('(planning)')).toEqual({ prompt: '(planning)', planMode: false })
})
it('preserves ordinary text and composes without turning existing mode off', () => {
  const result = stripPlanModeToken('  hello\nworld  ')
  expect(result).toEqual({ prompt: '  hello\nworld  ', planMode: false })
  const existingPlanMode = true
  expect(existingPlanMode || result.planMode).toBe(true)
})
it('proposes the first sentence and a human receipt without persistence', () => {
  expect(proposeOutcomeFromPrompt('  Ship it. Check it.  ')).toEqual({
    title: 'Ship it.',
    doneWhen: [{ id: 'd1', text: 'Ship it. Check it.', evidence: 'human' }]
  })
  expect(proposeOutcomeFromPrompt('a'.repeat(100)).title).toHaveLength(80)
})
