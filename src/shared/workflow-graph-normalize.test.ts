import { describe, expect, it } from 'vitest'
import type { WorkflowSpec } from './workflow-graph'
import { normalizeWorkflowSpec } from './workflow-graph-normalize'
import { workflowTemplate } from './workflow-graph-templates'
const spec = (raw: Record<string, unknown>): WorkflowSpec => normalizeWorkflowSpec(raw)

const researchCriticsFinal = {
  title: 'Research',
  steps: [
    { id: 'research', kind: 'do', title: 'Research', agents: [{}, {}, {}, {}], inputs: [] },
    { id: 'critics', kind: 'review', title: 'Critics', agents: [{}, {}], inputs: ['research'] },
    {
      id: 'final',
      kind: 'synthesize',
      title: 'Final',
      agents: [{}],
      inputs: ['research', 'critics']
    }
  ]
}

describe('normalizeWorkflowSpec', () => {
  it('fills defaults and rotates families, skipping Gemini for judging steps', () => {
    const result = spec(researchCriticsFinal)
    expect(result.steps[0].agents.map((agent) => agent.route)).toEqual([
      'claude',
      'codex',
      'grok',
      'gemini'
    ])
    // Judging steps start one family later and never use Gemini.
    expect(result.steps[1].agents.map((agent) => agent.route)).toEqual(['codex', 'grok'])
    // The synthesizer defaults to the first eligible family: Claude.
    expect(result.steps[2].agents).toEqual([{ route: 'claude' }])
  })

  it('slugs ids, keeps edges pointing at the renamed steps and de-duplicates ids', () => {
    const result = spec({
      steps: [
        { id: 'Deep Research!', kind: 'do', title: 'A', agents: [{}, {}] },
        { id: 'Deep Research!', kind: 'do', title: 'B', agents: [{}] },
        { id: 'sum', kind: 'synthesize', title: 'S', inputs: ['Deep Research!'] }
      ]
    })
    expect(result.steps.map((step) => step.id)).toEqual(['deep-research', 'deep-research-2', 'sum'])
    expect(result.steps[2].inputs).toEqual(['deep-research'])
  })

  it('forces a single synthesizer, replaces Gemini in a judging step and clamps counts', () => {
    const result = spec({
      steps: [
        { id: 'a', kind: 'do', title: 'A', agents: Array.from({ length: 20 }, () => ({})) },
        {
          id: 's',
          kind: 'synthesize',
          title: 'S',
          agents: [{ route: 'gemini' }, { route: 'claude' }],
          inputs: ['a']
        }
      ]
    })
    expect(result.steps[0].agents).toHaveLength(8)
    expect(result.steps[1].agents).toHaveLength(1)
    expect(result.steps[1].agents[0].route).not.toBe('gemini')
  })

  it('only uses routes that are available', () => {
    const result = normalizeWorkflowSpec(researchCriticsFinal, ['claude', 'grok'])
    for (const step of result.steps) {
      for (const agent of step.agents) {
        expect(['claude', 'grok']).toContain(agent.route)
      }
    }
  })

  it('adds a for-each source to the inputs', () => {
    const result = spec({
      steps: [
        { id: 'list', kind: 'do', title: 'L', list: true },
        { id: 'each', kind: 'do', title: 'E', forEach: 'list', agents: [{}, {}] },
        { id: 'sum', kind: 'synthesize', title: 'S', inputs: ['each'] }
      ]
    })
    expect(result.steps[1].inputs).toEqual(['list'])
    expect(result.steps[1].forEach).toEqual({ step: 'list', limit: 12 })
    expect(result.steps[0].list).toEqual({ maxItems: 8 })
  })

  it('keeps list.evidence only when it is exactly true, and Discover turns it on for Find', () => {
    const lists = spec({
      steps: [
        { id: 'a', kind: 'do', title: 'A', list: { maxItems: 4, evidence: true } },
        { id: 'b', kind: 'do', title: 'B', list: { maxItems: 4, evidence: 'yes' }, inputs: ['a'] },
        { id: 'c', kind: 'synthesize', title: 'C', inputs: ['b'] }
      ]
    }).steps.map((step) => step.list)
    expect(lists).toEqual([{ maxItems: 4, evidence: true }, { maxItems: 4 }, undefined])
    const discover = workflowTemplate('discover').steps
    expect(discover.find((step) => step.id === 'find')!.list).toEqual({
      maxItems: 6,
      evidence: true
    })
    expect(discover.find((step) => step.id === 'scout')!.list).toEqual({ maxItems: 6 })
  })
})
