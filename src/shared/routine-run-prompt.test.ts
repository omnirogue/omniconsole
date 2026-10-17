import { expect, it } from 'vitest'
import type { Automation } from './automations-types'
import { buildRoutineRunPrompt, routineAgentTemplate } from './routine-run-prompt'

it('keeps definition context and structured conclusions together without changing saved prompts', () => {
  const automation = {
    prompt: 'Review the repository.',
    contextPaths: ['docs/*.md'],
    outputFormat: 'markdown',
    structuredOutput: { provider: 'typesafe', contract: 'classification.v1' }
  } as Automation
  const prompt = buildRoutineRunPrompt(automation, 'Review only this change.')
  expect(prompt).toContain('Routine definition context:')
  expect(prompt).toContain('docs/*.md')
  expect(prompt).toContain('Required output format: markdown')
  expect(prompt).toContain('"notable": boolean')
  expect(prompt).toContain('End routine definition context.\n\nReview only this change.')
  expect(prompt).toContain('classification.v1')
  expect(prompt).toContain('INCONCLUSIVE')
  expect(prompt).not.toContain('Review the repository.')
  expect(automation.prompt).toBe('Review the repository.')
})

it('carries the routine template after the task and keeps the result contract last', () => {
  const automation = {
    prompt: 'Review the repository.',
    outputFormat: 'markdown',
    agentTemplateId: 'reviewer'
  } as Automation
  const template = routineAgentTemplate({}, automation)
  expect(template?.instructions).toMatch(/^# Reviewer/)
  const prompt = buildRoutineRunPrompt(automation, automation.prompt, template)
  expect(prompt.startsWith('Routine definition context:')).toBe(true)
  expect(prompt).toContain(
    `Review the repository.\n\n---\n\nStanding instructions for this session (agent template "Reviewer"; follow them throughout):\n${template?.instructions}`
  )
  // Why: the result parser only accepts the routine-result block at the very end of the output.
  expect(
    prompt.endsWith(
      'end the output with the routine-result block described in the routine definition context.'
    )
  ).toBe(true)
  expect(buildRoutineRunPrompt(automation)).not.toContain('Whatever the standing instructions')
  expect(prompt).not.toContain('agentTemplateId')
  expect(routineAgentTemplate(null, { agentTemplateId: 'default' })).toBeNull()
  expect(routineAgentTemplate(null, { agentTemplateId: 'custom-missing' })).toBeNull()
  expect(buildRoutineRunPrompt(automation)).toMatch(/^Routine definition context:/)
})

it("leads a run in a project with the project's brief and keeps the folder id out of the context", () => {
  const automation = {
    prompt: 'Check the ads.',
    outputFormat: 'markdown',
    sessionFolder: 'project-1'
  } as Automation
  const prompt = buildRoutineRunPrompt(automation, automation.prompt, null, 'Project: Ads')
  expect(prompt.startsWith('Project: Ads\n\nRoutine definition context:')).toBe(true)
  expect(prompt).not.toContain('sessionFolder')
  expect(buildRoutineRunPrompt(automation).startsWith('Routine definition context:')).toBe(true)
})
