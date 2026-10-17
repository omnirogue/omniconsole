import { quickDiscoverWorkflow, quickDiscoverTargets } from './workflow-graph-quick-discover'
import { normalizeWorkflowSpec } from './workflow-graph-normalize'
import { describe, expect, it } from 'vitest'
import { planWorkflowCalls } from './workflow-graph-topology'
import { workflowTemplate } from './workflow-graph-templates'
import { validateWorkflowSpec } from './workflow-graph-validate'
import {
  quickDiscoverBudget,
  quickDiscoverOverBudgetMessage
} from './workflow-quick-discover-budget'
import { workflowModelContextTokens } from './workflow-model-context-window'

describe('Quick Discover template', () => {
  it('reads the whole scope, then independently verifies without a report call', () => {
    const spec = normalizeWorkflowSpec(quickDiscoverWorkflow(['codex', 'claude', 'gemini'], true))
    expect(spec.template).toBe('quick-discover')
    expect(
      validateWorkflowSpec(spec, { available: ['codex', 'claude', 'gemini'] }).problems
    ).toEqual([])
    expect(spec.steps.map((step) => [step.id, step.kind, step.agents.map((a) => a.route)])).toEqual(
      [
        ['find', 'do', ['claude']],
        ['verify', 'review', ['codex']]
      ]
    )
    const find = spec.steps[0]!
    // No inputs: the prompt carries the attached files (graph-prompts.ts).
    expect(find.inputs).toEqual([])
    expect(find.list).toEqual({ maxItems: 20, evidence: true })
    expect(spec.repeat).toBeUndefined()
    expect(planWorkflowCalls(spec).agentTotal).toBe(21)
    expect(spec.steps[1]!.forEach).toEqual({ step: 'find', limit: 20 })
  })

  it('falls back to the one family set up', () => {
    const spec = workflowTemplate('quick-discover', ['codex'])
    expect(spec.steps.every((step) => step.agents[0]!.route === 'codex')).toBe(true)
  })
})

describe('Quick Discover budget', () => {
  it('keeps 60% of the seat model context window, 1M only where the model asks for it', () => {
    expect(workflowModelContextTokens('claude', 'claude-opus-5')).toBe(200_000)
    expect(workflowModelContextTokens('claude', 'claude-opus-5[1m]')).toBe(1_000_000)
    expect(workflowModelContextTokens('gemini', 'gemini-3.8-flash')).toBe(1_000_000)
    expect(workflowModelContextTokens('codex', 'gpt-5.6-sol')).toBe(200_000)
    expect(quickDiscoverBudget('claude', 'claude-opus-5')).toEqual({
      contextTokens: 200_000,
      budgetTokens: 120_000,
      model: 'claude-opus-5'
    })
  })

  it('says why it refused and what to run instead', () => {
    expect(
      quickDiscoverOverBudgetMessage(513_000, quickDiscoverBudget('claude', 'claude-opus-5'))
    ).toBe(
      "Quick Discover reads the whole scope in one call, and this scope is about 513,000 tokens: over its budget of 120,000 (60% of claude-opus-5's 200,000-token context). Run Discover instead (--template discover), or choose a smaller folder." +
        ' Or read it with the 1M-context Opus seat: choose claude-opus-5-5[1m] for the reader, or pass --spec-file with {"steps":{"find":{"agents":[{"route":"claude","model":"claude-opus-5-5[1m]"}]}}}.'
    )
    // Past the 1M seat's own budget, or already on it, only Discover is left.
    for (const [tokens, model] of [
      [700_000, 'claude-opus-5'],
      [700_000, 'claude-opus-5-5[1m]']
    ] as const) {
      expect(
        quickDiscoverOverBudgetMessage(tokens, quickDiscoverBudget('claude', model))
      ).not.toContain('1M-context Opus seat')
    }
  })
})

it('uses Verify verdicts for Quick targets instead of forcing single pass', () => {
  const graph = {
    steps: [
      {
        id: 'find',
        rounds: [
          {
            round: 1,
            items: [
              {
                key: 'k',
                title: 'Finding',
                location: 'a.ts:1',
                severity: 'high',
                detail: 'Evidence',
                repeats: 0
              }
            ]
          }
        ]
      },
      {
        id: 'verify',
        rounds: [
          {
            round: 1,
            targets: [
              {
                key: 'k',
                title: 'Finding',
                location: 'a.ts:1',
                severity: 'high',
                detail: 'Evidence',
                repeats: 0,
                tally: 'confirmed',
                votes: ['pass']
              }
            ]
          }
        ]
      }
    ]
  } as unknown as Parameters<typeof quickDiscoverTargets>[0]
  expect(quickDiscoverTargets(graph)).toEqual([
    expect.objectContaining({ key: 'k', tally: 'confirmed', votes: ['pass'] })
  ])
  expect(quickDiscoverTargets(graph)[0]).not.toHaveProperty('singlePass')
})

it('admits the host-rendered terminal Quick list while rejecting an unused generic list', () => {
  const spec = workflowTemplate('quick-discover', ['claude', 'codex'])
  expect(validateWorkflowSpec(spec, { available: ['claude', 'codex'] }).problems).toEqual([])
  expect(planWorkflowCalls(spec).agentTotal).toBe(1)
  expect(
    validateWorkflowSpec({ ...spec, template: 'discover' }, { available: ['claude', 'codex'] })
      .problems
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('list would never be used') })
    ])
  )
})
