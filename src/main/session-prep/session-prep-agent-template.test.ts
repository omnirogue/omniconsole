import { describe, expect, it } from 'vitest'
import {
  sessionPrepAgentTemplateChoices,
  sessionPrepAgentTemplateId,
  sessionPrepAgentTemplate
} from './session-prep-agent-template'
import type { PlannedItem } from '../../shared/session-prep-types'

const planned = (choices?: PlannedItem['choices']): { planned: PlannedItem } => ({
  planned: { title: 'A', ask: 'a', anchor: 'a', direct: false, changesCode: false, choices }
})

describe('session prep agent templates', () => {
  it('offers the planner every template except Default', () => {
    const choices = sessionPrepAgentTemplateChoices({
      custom: [{ id: 'docs', name: 'Docs', description: '', instructions: '# Docs' }]
    })
    expect(choices.map((entry) => entry.id)).toEqual([
      'developer',
      'reviewer',
      'researcher',
      'coordinator',
      'docs'
    ])
  })

  it('lets an item-named template win over the batch choice', () => {
    expect(sessionPrepAgentTemplateId({ agentTemplateId: 'reviewer' }, planned())).toBe('reviewer')
    expect(
      sessionPrepAgentTemplateId(
        { agentTemplateId: 'reviewer' },
        planned({ agentTemplate: 'researcher' })
      )
    ).toBe('researcher')
    expect(sessionPrepAgentTemplateId({}, planned())).toBeUndefined()
  })

  it('resolves text from this host settings, null for Default or a missing template', () => {
    expect(
      sessionPrepAgentTemplate(undefined, { agentTemplateId: 'reviewer' }, planned())
    ).toMatchObject({ name: 'Reviewer', instructions: expect.stringMatching(/^# Reviewer/) })
    expect(
      sessionPrepAgentTemplate(undefined, { agentTemplateId: 'default' }, planned())
    ).toBeNull()
    expect(sessionPrepAgentTemplate(undefined, { agentTemplateId: 'gone' }, planned())).toBeNull()
  })
})
