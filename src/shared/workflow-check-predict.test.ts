import { describe, expect, it } from 'vitest'
import { normalizeWorkflowCheck } from './workflow-check-normalize'
import type { WorkflowCheck, WorkflowSpec } from './workflow-graph'
import { compileWorkflowDescription } from './workflow-graph-compile'
import { workflowTemplate } from './workflow-graph-templates'
import { planWorkflowCalls } from './workflow-graph-topology'
import { workflowCheckHasPractice } from './workflow-improve-host-calls'

const ROUTES = ['claude', 'codex', 'grok'] as const

function improve(check?: WorkflowCheck): WorkflowSpec {
  const spec = workflowTemplate('improve', ROUTES)
  return { ...spec, repeat: { ...spec.repeat!, ...(check ? { check } : {}) } }
}

describe('a check whose versions must predict their result', () => {
  it('keeps predict only as true, and only on Improve', () => {
    expect(normalizeWorkflowCheck({ command: 'x', predict: true }, true)).toEqual({
      check: { command: 'x', predict: true }
    })
    expect(normalizeWorkflowCheck({ command: 'x', predict: 'yes' }, true)).toEqual({
      check: { command: 'x' }
    })
    expect(normalizeWorkflowCheck({ command: 'x', predict: true })).toEqual({
      check: { command: 'x' }
    })
  })

  it('is a rules-2 field: its checks count as host calls, and older rules never carry it', () => {
    expect(workflowCheckHasPractice({ command: 'x', predict: true })).toBe(true)
    expect(planWorkflowCalls(improve({ command: 'x', predict: true })).hostTotal).toBeGreaterThan(0)
    expect(planWorkflowCalls(improve({ command: 'x' })).hostTotal).toBe(0)
  })
})

describe('only the person sets predictions', () => {
  const answer = (check: Record<string, unknown>) =>
    JSON.stringify({
      title: 'Improve',
      task: '',
      steps: improve().steps,
      repeat: { do: 'improve', review: 'judge', until: 'plateau', maxRounds: 6, check },
      assumptions: []
    })

  it('never lets a model turn predictions on or off', async () => {
    const own: WorkflowCheck = { command: 'pnpm test' }
    const added = await compileWorkflowDescription({
      description: 'Make every version predict its result',
      current: improve(own),
      available: ['claude', 'codex'],
      ask: async () => answer({ command: 'pnpm test', predict: true })
    })
    expect('spec' in added && added.spec.repeat?.check).toEqual(own)
    const mine: WorkflowCheck = { command: 'pnpm test', predict: true }
    const dropped = await compileWorkflowDescription({
      description: 'Use 5 candidates',
      current: improve(mine),
      available: ['claude', 'codex'],
      ask: async () => answer({ command: 'pnpm test' })
    })
    expect('spec' in dropped && dropped.spec.repeat?.check).toEqual(mine)
  })
})
