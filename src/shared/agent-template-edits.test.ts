import { describe, expect, it } from 'vitest'
import {
  MAX_AGENT_TEMPLATE_INSTRUCTIONS_LENGTH,
  MAX_CUSTOM_AGENT_TEMPLATES,
  agentTemplateDigest,
  resolveAgentTemplates,
  type AgentTemplateSettings
} from './agent-templates'
import {
  agentTemplateRecords,
  applyAgentTemplateEdit,
  removeAgentTemplate
} from './agent-template-edits'

const stored: AgentTemplateSettings = {
  custom: [
    {
      id: 'advertising',
      name: 'Advertising',
      description: 'Pauses by evidence',
      instructions: '# Advertising\nPause, never scale.',
      preferredModel: 'anthropic/claude-sonnet'
    }
  ]
}

function failure(result: { ok: boolean; message?: string }): string {
  expect(result.ok).toBe(false)
  return result.message ?? ''
}

describe('agentTemplateRecords', () => {
  it('lists built-ins with overrides applied, then custom templates, each with its digest', () => {
    const records = agentTemplateRecords(stored)
    expect(records.map((record) => record.id)).toEqual([
      'default',
      'developer',
      'reviewer',
      'researcher',
      'coordinator',
      'advertising'
    ])
    expect(records.at(-1)).toMatchObject({
      builtin: false,
      preferredModel: 'anthropic/claude-sonnet',
      digest: agentTemplateDigest('# Advertising\nPause, never scale.')
    })
  })
})

describe('applyAgentTemplateEdit', () => {
  it('updates a custom template and keeps the fields it was not given', () => {
    const result = applyAgentTemplateEdit(stored, {
      id: 'advertising',
      instructions: '# Advertising\r\nPause first.\n'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.template).toMatchObject({
      name: 'Advertising',
      description: 'Pauses by evidence',
      preferredModel: 'anthropic/claude-sonnet',
      instructions: '# Advertising\nPause first.',
      digest: agentTemplateDigest('# Advertising\nPause first.')
    })
  })

  it('creates a custom template when given a name', () => {
    const result = applyAgentTemplateEdit(stored, {
      id: 'qa',
      name: 'QA',
      instructions: '# QA\nTest first.'
    })
    expect(result.ok && result.settings.custom?.map((entry) => entry.id)).toEqual([
      'advertising',
      'qa'
    ])
  })

  it('overrides a built-in without renaming it', () => {
    const result = applyAgentTemplateEdit(stored, {
      id: 'reviewer',
      description: 'Reads diffs',
      instructions: '# Reviewer\nNo edits.'
    })
    expect(result.ok).toBe(true)
    const reviewer = resolveAgentTemplates(result.ok ? result.settings : {}).find(
      (entry) => entry.id === 'reviewer'
    )
    expect(reviewer).toMatchObject({
      name: 'Reviewer',
      description: 'Reads diffs',
      instructions: '# Reviewer\nNo edits.',
      edited: true
    })
    expect(
      failure(applyAgentTemplateEdit(stored, { id: 'reviewer', name: 'R', instructions: 'x' }))
    ).toContain('names cannot be changed')
  })

  it('refuses Default, bad ids, unnamed new ids and empty text', () => {
    expect(failure(applyAgentTemplateEdit(stored, { id: 'default', instructions: 'x' }))).toContain(
      'Default'
    )
    expect(failure(applyAgentTemplateEdit(stored, { id: 'Bad Id', instructions: 'x' }))).toContain(
      'not a template id'
    )
    expect(failure(applyAgentTemplateEdit(stored, { id: 'new-one', instructions: 'x' }))).toContain(
      '--name'
    )
    expect(
      failure(applyAgentTemplateEdit(stored, { id: 'advertising', instructions: '  \n ' }))
    ).toContain('Instructions cannot be empty')
  })

  it('refuses text over the limits instead of cutting it', () => {
    const long = 'x'.repeat(MAX_AGENT_TEMPLATE_INSTRUCTIONS_LENGTH + 1)
    expect(
      failure(applyAgentTemplateEdit(stored, { id: 'advertising', instructions: long }))
    ).toContain(`limit is ${MAX_AGENT_TEMPLATE_INSTRUCTIONS_LENGTH}`)
    expect(
      failure(applyAgentTemplateEdit(stored, { id: 'qa', name: 'n'.repeat(81), instructions: 'x' }))
    ).toContain('limit is 80')
  })

  it('refuses a new template past the custom cap', () => {
    const full: AgentTemplateSettings = {
      custom: Array.from({ length: MAX_CUSTOM_AGENT_TEMPLATES }, (_, index) => ({
        id: `t-${index}`,
        name: `T ${index}`,
        description: '',
        instructions: 'x'
      }))
    }
    expect(
      failure(applyAgentTemplateEdit(full, { id: 'one-more', name: 'One', instructions: 'x' }))
    ).toContain(`already ${MAX_CUSTOM_AGENT_TEMPLATES}`)
    expect(applyAgentTemplateEdit(full, { id: 't-3', instructions: 'y' }).ok).toBe(true)
  })
})

describe('removeAgentTemplate', () => {
  it('removes a custom template', () => {
    const result = removeAgentTemplate(stored, 'advertising')
    expect(result).toEqual({ ok: true, settings: {} })
  })

  it('refuses built-ins and unknown ids', () => {
    expect(failure(removeAgentTemplate(stored, 'developer'))).toContain('built in')
    expect(failure(removeAgentTemplate(stored, 'default'))).toContain('Default')
    expect(failure(removeAgentTemplate(stored, 'missing'))).toContain('No custom template')
  })

  it('treats a person’s own coordinator as theirs, and the built-in as built in otherwise', () => {
    const mine: AgentTemplateSettings = {
      custom: [{ id: 'coordinator', name: 'Lead', description: '', instructions: '# Lead' }]
    }
    const renamed = applyAgentTemplateEdit(mine, {
      id: 'coordinator',
      name: 'Project lead',
      instructions: '# Lead'
    })
    expect(renamed.ok && renamed.settings.custom?.[0]?.name).toBe('Project lead')
    expect(removeAgentTemplate(mine, 'coordinator')).toEqual({ ok: true, settings: {} })
    expect(
      failure(applyAgentTemplateEdit({}, { id: 'coordinator', name: 'X', instructions: 'x' }))
    ).toContain('names cannot be changed')
    expect(failure(removeAgentTemplate({}, 'coordinator'))).toContain('built in')
  })
})
