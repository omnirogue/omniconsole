import { describe, expect, it } from 'vitest'
import { resolveAgentTemplates } from '../../../../shared/agent-templates'
import { workflowSeatSystemFor, workflowSeatTemplate } from './workflow-seat-template'

const long = 'x'.repeat(4_500)
const templates = resolveAgentTemplates({
  custom: [{ id: 'long', name: 'Long', description: '', instructions: long }]
})
const byId = (id: string) => templates.find((template) => template.id === id)

describe('workflow seat templates', () => {
  it('fills the seat system prompt with the template text', () => {
    const filled = workflowSeatSystemFor(byId('reviewer'))
    expect(filled.system).toMatch(/^# Reviewer/)
    expect(filled.cut).toBe(false)
    expect(workflowSeatSystemFor(byId('default'))).toEqual({ system: '', cut: false })
  })

  it('cuts a long template to the seat limit and says so', () => {
    const filled = workflowSeatSystemFor(byId('long'))
    expect(filled.system).toHaveLength(4_000)
    expect(filled.cut).toBe(true)
  })

  it('recognizes which template a system prompt came from, and none for own text', () => {
    expect(
      workflowSeatTemplate(templates, workflowSeatSystemFor(byId('reviewer')).system)?.id
    ).toBe('reviewer')
    expect(workflowSeatTemplate(templates, long)?.id).toBe('long')
    expect(workflowSeatTemplate(templates, 'You are a skeptical CFO.')).toBeNull()
    expect(workflowSeatTemplate(templates, '')).toBeNull()
  })

  it('keeps recognition and the cut note when the limit falls on whitespace', () => {
    const spaced = `${'y'.repeat(3_998)}  and more words`
    const list = resolveAgentTemplates({
      custom: [{ id: 'spaced', name: 'Spaced', description: '', instructions: spaced }]
    })
    const filled = workflowSeatSystemFor(list.find((template) => template.id === 'spaced'))
    expect(filled.system).toBe('y'.repeat(3_998))
    expect(filled.cut).toBe(true)
    expect(workflowSeatTemplate(list, filled.system)?.id).toBe('spaced')
    expect(workflowSeatTemplate(list, `${filled.system}  `)?.id).toBe('spaced')
  })
})
