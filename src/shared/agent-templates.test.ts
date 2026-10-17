import { describe, expect, it } from 'vitest'
import {
  agentTemplateIdFromName,
  agentTemplateMatches,
  findAgentTemplate,
  normalizeAgentTemplateSettings,
  resolveAgentTemplates
} from './agent-templates'
import {
  agentTemplateInstructions,
  withAgentTemplateInstructions,
  withoutAgentTemplateInstructions
} from './agent-template-dispatch'

describe('agent template settings', () => {
  it('ships five built-ins and keeps Default empty', () => {
    const templates = resolveAgentTemplates(undefined)
    expect(templates.map((template) => template.id)).toEqual([
      'default',
      'developer',
      'reviewer',
      'researcher',
      'coordinator'
    ])
    expect(templates[0]!.instructions).toBeNull()
    expect(templates.every((template) => template.builtin && !template.edited)).toBe(true)
  })

  it('applies overrides to built-ins and marks them edited', () => {
    const templates = resolveAgentTemplates({
      overrides: {
        reviewer: {
          instructions: '# Reviewer\r\nBe terse.\r\n',
          preferredModel: 'ollama/gemma3:12b'
        },
        default: { instructions: 'must be ignored' },
        'not-a-builtin': { instructions: 'ignored too' }
      }
    })
    const reviewer = findAgentTemplate(templates, 'reviewer')
    expect(reviewer.edited).toBe(true)
    expect(reviewer.instructions).toBe('# Reviewer\nBe terse.')
    expect(reviewer.preferredModel).toBe('ollama/gemma3:12b')
    expect(findAgentTemplate(templates, 'default').instructions).toBeNull()
    expect(templates).toHaveLength(5)
  })

  it("tells a project's coordinator to start threads as workers and follow them", () => {
    const coordinator = findAgentTemplate(resolveAgentTemplates(undefined), 'coordinator')
    expect(coordinator.instructions).toContain('omni orchestration run-create --objective')
    expect(coordinator.instructions).toContain('omni orchestration run-use --id')
    expect(coordinator.instructions).toContain('omni orchestration worker-start --task')
    expect(coordinator.instructions).toContain("The worker gets this project's line and context")
    expect(coordinator.instructions).toContain('omni session list --project')
    expect(coordinator.instructions).toContain('Never create a project')
  })

  it('lets a template the person already named coordinator keep its id over the later built-in', () => {
    const settings = normalizeAgentTemplateSettings({
      custom: [{ name: 'Coordinator', description: 'Mine', instructions: '# Mine' }]
    })
    expect(settings.custom?.map((entry) => entry.id)).toEqual(['coordinator'])
    const templates = resolveAgentTemplates(settings)
    expect(templates.filter((template) => template.id === 'coordinator')).toEqual([
      expect.objectContaining({ builtin: false, instructions: '# Mine' })
    ])
    expect(templates).toHaveLength(5)
  })

  it('normalizes custom templates: ids from names, no built-in or duplicate ids, no secrets', () => {
    const settings = normalizeAgentTemplateSettings({
      custom: [
        { name: 'Release notes', description: 'Changelogs', instructions: 'Write bullets.' },
        { id: 'reviewer', name: 'Sneaky', instructions: 'x' },
        { id: 'release-notes', name: 'Dup', instructions: 'y' },
        { name: '   ', instructions: 'no name' },
        {
          id: 'docs',
          name: 'Docs',
          instructions: 'z',
          apiKey: 'nope',
          preferredModel: 'bad model id'
        }
      ]
    })
    expect(settings.custom).toEqual([
      {
        id: 'release-notes',
        name: 'Release notes',
        description: 'Changelogs',
        instructions: 'Write bullets.'
      },
      { id: 'docs', name: 'Docs', description: '', instructions: 'z' }
    ])
    expect(JSON.stringify(settings)).not.toContain('nope')
  })

  it('returns an empty object for junk and drops empty overrides', () => {
    expect(normalizeAgentTemplateSettings(null)).toEqual({})
    expect(normalizeAgentTemplateSettings('text')).toEqual({})
    expect(
      normalizeAgentTemplateSettings({ overrides: { developer: { description: '  ' } } })
    ).toEqual({})
  })

  it('slugs names into OpenCode-safe ids', () => {
    expect(agentTemplateIdFromName('Release Notes Writer!')).toBe('release-notes-writer')
    expect(agentTemplateIdFromName('***')).toBe('agent')
  })

  it('matches on name or description, case-insensitively', () => {
    const [, developer] = resolveAgentTemplates(undefined)
    expect(agentTemplateMatches(developer!, 'DEV')).toBe(true)
    expect(agentTemplateMatches(developer!, 'diffs')).toBe(true)
    expect(agentTemplateMatches(developer!, 'zzz')).toBe(false)
  })
})

describe('dispatch helpers', () => {
  it('resolves a template to its name and text, never borrowing another for an unknown id', () => {
    expect(agentTemplateInstructions(undefined, 'reviewer')).toMatchObject({
      name: 'Reviewer',
      instructions: expect.stringContaining('Read-only')
    })
    expect(agentTemplateInstructions(undefined, 'default')).toBeNull()
    expect(agentTemplateInstructions(undefined, null)).toBeNull()
    expect(agentTemplateInstructions(undefined, 'gone')).toBeNull()
    expect(
      agentTemplateInstructions(
        { custom: [{ id: 'ops', name: 'Ops', description: '', instructions: '  Be brief.  ' }] },
        'ops'
      )
    ).toEqual({ name: 'Ops', instructions: 'Be brief.' })
  })

  it('puts the task first and the template after it, or leaves the prompt alone', () => {
    const ops = { name: 'Ops', instructions: 'Be brief.' }
    expect(withAgentTemplateInstructions('Do the task.', ops)).toBe(
      'Do the task.\n\n---\n\nStanding instructions for this session (agent template "Ops"; follow them throughout):\nBe brief.'
    )
    expect(withAgentTemplateInstructions('Do the task.', null)).toBe('Do the task.')
    expect(withAgentTemplateInstructions('Do the task.', { name: 'Ops', instructions: '  ' })).toBe(
      'Do the task.'
    )
  })

  it('sends the plain template text when nothing was typed', () => {
    expect(withAgentTemplateInstructions('  ', { name: 'Ops', instructions: 'Be brief.' })).toBe(
      'Be brief.'
    )
    expect(withAgentTemplateInstructions('', null)).toBe('')
  })

  it('recovers the task by the lead line, whatever dividers the task or template hold', () => {
    const task = 'Fix the login.\n\n---\n\nThen ship.'
    const led = withAgentTemplateInstructions(task, {
      name: 'Ops',
      instructions: '# Ops\n\n---\n\nBe brief.'
    })
    expect(withoutAgentTemplateInstructions(led)).toBe(task)
    expect(withoutAgentTemplateInstructions(task)).toBe(task)
    // The hook preview collapses whitespace and cuts at 200 characters, lead line included.
    const flat =
      'Fix the login bug --- Standing instructions for this session (agent template "Reviewer"; follow them throughout): # Reviewer Read-only.'
    expect(withoutAgentTemplateInstructions(flat)).toBe('Fix the login bug')
    // A lead cut mid-way counts only at the 200-character preview end, never a short own tail.
    const cutPreview = `${'Fix the login bug in the account settings page. '.repeat(4)}--- Standing instr`
    expect(cutPreview.length).toBeGreaterThanOrEqual(190)
    expect(withoutAgentTemplateInstructions(cutPreview)).toBe(
      'Fix the login bug in the account settings page. '.repeat(4).trimEnd()
    )
    expect(withoutAgentTemplateInstructions('Fix the login bug --- Standing instr')).toBe(
      'Fix the login bug --- Standing instr'
    )
    expect(withoutAgentTemplateInstructions('Ship the hotfix --- S')).toBe('Ship the hotfix --- S')
    expect(withoutAgentTemplateInstructions('Step one --- then step two')).toBe(
      'Step one --- then step two'
    )
  })
})
