import { describe, expect, it } from 'vitest'
import { assembleQuickComposerTexts, quickComposerAgentTemplate } from './quick-composer-texts'

const project = {
  line: 'Project: Ads',
  context:
    '--- BEGIN ATTACHED SESSION CONTEXT ---\nslite: Ads plan\n--- END ATTACHED SESSION CONTEXT ---',
  agent: { name: 'Reviewer', instructions: 'Review carefully' }
}

describe('a workspace made from a project', () => {
  it('opens with the project line and carries its context after the task', () => {
    const { prompt } = assembleQuickComposerTexts({
      prompt: 'Fix checkout',
      draftPrompt: undefined,
      agentTemplate: project.agent,
      project
    })
    const parts = prompt.split('\n\n')
    expect(parts[0]).toBe('Project: Ads')
    expect(parts[1]).toBe('Fix checkout')
    expect(prompt).toContain('agent template "Reviewer"')
    expect(prompt.endsWith('--- END ATTACHED SESSION CONTEXT ---')).toBe(true)
  })

  it('wraps a draft the same way and leaves the prompt alone', () => {
    const texts = assembleQuickComposerTexts({
      prompt: '',
      draftPrompt: 'Draft task',
      agentTemplate: null,
      project
    })
    expect(texts.prompt).toBe('')
    expect(texts.draftPrompt?.startsWith('Project: Ads\n\nDraft task')).toBe(true)
  })

  it('changes nothing outside a project', () => {
    expect(
      assembleQuickComposerTexts({ prompt: 'Task', draftPrompt: undefined, agentTemplate: null })
        .prompt
    ).toBe('Task')
  })

  it('uses the project agent only when no template was chosen', () => {
    expect(quickComposerAgentTemplate('claude', undefined, undefined, project.agent)).toBe(
      project.agent
    )
    expect(quickComposerAgentTemplate(null, undefined, undefined, project.agent)).toBeNull()
    // Why the built-in: a chosen template's own text wins over the project's agent.
    const chosen = quickComposerAgentTemplate('claude', undefined, 'reviewer', project.agent)
    expect(chosen?.instructions).toBeTruthy()
    expect(chosen?.instructions).not.toBe(project.agent.instructions)
  })
})
