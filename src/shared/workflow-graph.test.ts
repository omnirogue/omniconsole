import { describe, expect, it } from 'vitest'
import type { WorkflowSpec } from './workflow-graph'
import { normalizeWorkflowSpec } from './workflow-graph-normalize'
import {
  describeWorkflow,
  planWorkflowCalls,
  workflowDescendants,
  workflowFinalStep,
  workflowTopology
} from './workflow-graph-topology'
import { validateWorkflowSpec } from './workflow-graph-validate'
import { workflowTemplate } from './workflow-graph-templates'

const spec = (raw: Record<string, unknown>): WorkflowSpec => normalizeWorkflowSpec(raw)
const problems = (raw: Record<string, unknown>, options = {}) =>
  validateWorkflowSpec(spec(raw), options).problems.map((entry) => entry.message)

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

describe('validateWorkflowSpec', () => {
  it('accepts Sal’s example and every template', () => {
    expect(problems(researchCriticsFinal)).toEqual([])
    for (const key of ['council', 'discover', 'research-panel'] as const) {
      expect(validateWorkflowSpec(workflowTemplate(key)).problems).toEqual([])
    }
    expect(
      validateWorkflowSpec(workflowTemplate('discover', undefined, { depth: 'quick' })).problems
    ).toEqual([])
  })

  it('requires another verifier family for thorough Discover and accepts the other templates', () => {
    for (const key of ['council', 'discover', 'research-panel'] as const) {
      const template = workflowTemplate(key, ['claude'])
      const found = validateWorkflowSpec(template).problems
      // Council needs peers; thorough Discover needs an independent verifier.
      if (key === 'council') {
        expect(found.map((entry) => entry.message).join(' ')).toContain('at least two answers')
      } else if (key === 'discover') {
        expect(found.map((entry) => entry.message).join(' ')).toContain('independent verifier')
      } else {
        expect(found).toEqual([])
      }
    }
  })

  it('refuses an empty workflow', () => {
    expect(problems({ steps: [] })).toEqual(['Add at least one step.'])
  })

  it('refuses a dangling input and a self input', () => {
    expect(
      problems({ steps: [{ id: 'a', kind: 'do', title: 'A', inputs: ['missing'] }] }).join(' ')
    ).toContain('does not exist')
    expect(
      problems({ steps: [{ id: 'a', kind: 'do', title: 'A', inputs: ['a'] }] }).join(' ')
    ).toContain('its own output')
  })

  it('refuses a cycle', () => {
    const found = problems({
      steps: [
        { id: 'a', kind: 'do', title: 'A', inputs: ['b'], agents: [{}, {}] },
        { id: 'b', kind: 'synthesize', title: 'B', inputs: ['a'] }
      ]
    })
    expect(found.join(' ')).toContain('circle')
  })

  it('refuses work nobody uses', () => {
    const found = problems({
      steps: [
        { id: 'a', kind: 'do', title: 'A', agents: [{}, {}] },
        { id: 'b', kind: 'do', title: 'Stray' },
        { id: 's', kind: 'synthesize', title: 'S', inputs: ['a'] }
      ]
    })
    expect(found.join(' ')).toContain("Stray's output isn't used by anything")
  })

  it('refuses a review with nothing to review, or reviewing a review', () => {
    expect(problems({ steps: [{ id: 'r', kind: 'review', title: 'R' }] }).join(' ')).toContain(
      'nothing to review'
    )
    const found = problems({
      steps: [
        { id: 'a', kind: 'do', title: 'A' },
        { id: 'r1', kind: 'review', title: 'R1', inputs: ['a'] },
        { id: 'r2', kind: 'review', title: 'R2', inputs: ['r1'] }
      ]
    })
    expect(found.join(' ')).toContain('must review work from a Do or Synthesize step')
  })

  it('refuses a ranking with fewer than two answers or over list items', () => {
    expect(
      problems({
        steps: [
          { id: 'a', kind: 'do', title: 'A', agents: [{}] },
          { id: 'r', kind: 'rank', title: 'R', inputs: ['a'] }
        ]
      }).join(' ')
    ).toContain('at least two answers')
    expect(
      problems({
        steps: [
          { id: 'a', kind: 'do', title: 'A', agents: [{}, {}], list: true },
          { id: 'r', kind: 'rank', title: 'R', inputs: ['a'] }
        ]
      }).join(' ')
    ).toContain('not list items')
  })

  it('refuses a synthesis of a single result', () => {
    expect(
      problems({
        steps: [
          { id: 'a', kind: 'do', title: 'A', agents: [{}] },
          { id: 's', kind: 'synthesize', title: 'S', inputs: ['a'] }
        ]
      }).join(' ')
    ).toContain('nothing to combine')
  })

  it('refuses for-each over a step that does not list', () => {
    const found = problems({
      steps: [
        { id: 'a', kind: 'do', title: 'A' },
        { id: 'e', kind: 'review', title: 'E', forEach: 'a' }
      ]
    })
    expect(found.join(' ')).toContain('does not produce a list')
  })

  it('refuses a list as the last step', () => {
    expect(
      problems({ steps: [{ id: 'a', kind: 'do', title: 'A', list: true }] }).join(' ')
    ).toContain('would never be used')
  })

  it('refuses Gemini in a judging step when given explicitly after normalization', () => {
    const graph = spec(researchCriticsFinal)
    graph.steps[1].agents[0] = { route: 'gemini' }
    expect(
      validateWorkflowSpec(graph)
        .problems.map((entry) => entry.message)
        .join(' ')
    ).toContain('Gemini can do work but never reviews')
  })

  it('refuses routes that are not available', () => {
    expect(
      validateWorkflowSpec(spec(researchCriticsFinal), { available: ['claude'] }).problems.length
    ).toBeGreaterThan(0)
  })

  it('checks repeat rules', () => {
    const base = {
      steps: [
        { id: 'draft', kind: 'do', title: 'Draft' },
        { id: 'critic', kind: 'review', title: 'Critic', inputs: ['draft'], agents: [{}, {}] }
      ]
    }
    expect(
      problems({ ...base, repeat: { do: 'draft', review: 'critic', until: 'approved' } })
    ).toEqual([])
    expect(
      problems({
        steps: [
          { id: 'draft', kind: 'do', title: 'Draft', agents: [{}, {}] },
          { id: 'critic', kind: 'review', title: 'Critic', inputs: ['draft'] }
        ],
        repeat: { do: 'draft', review: 'critic', until: 'approved' }
      }).join(' ')
    ).toContain('exactly one agent')
    expect(
      problems({ ...base, repeat: { do: 'draft', review: 'critic', until: 'nothing-new' } }).join(
        ' '
      )
    ).toContain('to produce a list')
    expect(
      problems({ ...base, repeat: { do: 'critic', review: 'draft', until: 'approved' } }).join(' ')
    ).toContain('Repeat must loop a Do step')
  })

  it('refuses a review input that runs after the looped step', () => {
    const found = problems({
      steps: [
        { id: 'draft', kind: 'do', title: 'Draft' },
        { id: 'notes', kind: 'do', title: 'Notes', inputs: ['draft'] },
        { id: 'critic', kind: 'review', title: 'Critic', inputs: ['draft', 'notes'] }
      ],
      repeat: { do: 'draft', review: 'critic', until: 'approved' }
    })
    expect(found.join(' ')).toContain('steps before it')
  })

  it('refuses graphs that could make too many calls', () => {
    const found = problems({
      steps: [
        {
          id: 'l',
          kind: 'do',
          title: 'L',
          agents: Array.from({ length: 8 }, () => ({})),
          list: { maxItems: 20 }
        },
        {
          id: 'e',
          kind: 'do',
          title: 'E',
          forEach: { step: 'l', limit: 24 },
          agents: Array.from({ length: 8 }, () => ({})),
          list: true
        },
        {
          id: 'v',
          kind: 'review',
          title: 'V',
          forEach: { step: 'e', limit: 24 },
          agents: Array.from({ length: 8 }, () => ({}))
        },
        { id: 's', kind: 'synthesize', title: 'S', inputs: ['v'] }
      ]
    })
    expect(found.join(' ')).toContain('limit is 200')
  })

  it('warns when reviewers share every family with the work they review', () => {
    const result = validateWorkflowSpec(
      spec({
        steps: [
          { id: 'a', kind: 'do', title: 'A', agents: [{ route: 'claude' }, { route: 'claude' }] },
          { id: 'r', kind: 'review', title: 'R', inputs: ['a'], agents: [{ route: 'claude' }] },
          { id: 's', kind: 'synthesize', title: 'S', inputs: ['a', 'r'] }
        ]
      })
    )
    expect(result.problems).toEqual([])
    expect(result.warnings.map((entry) => entry.stepId)).toContain('r')
  })
})

describe('topology and planning', () => {
  it('orders steps, levels them and finds the single final step', () => {
    const graph = spec(researchCriticsFinal)
    const topology = workflowTopology(graph)
    expect(topology.order).toEqual(['research', 'critics', 'final'])
    expect([...topology.level.entries()]).toEqual([
      ['research', 0],
      ['critics', 1],
      ['final', 2]
    ])
    expect(workflowFinalStep(graph)?.id).toBe('final')
    expect([...workflowDescendants(graph, 'research')].sort()).toEqual(['critics', 'final'])
  })

  it('computes the exact upper bound of agent calls', () => {
    expect(planWorkflowCalls(spec(researchCriticsFinal)).total).toBe(7)
    expect(planWorkflowCalls(workflowTemplate('council')).total).toBe(4 + 3 + 1 + 3)
    // Discover: brief 1 + scout 1 + find 6 areas x 3 lenses x 2 rounds + verify (40 first reviews
    // + 8 escalated x 2 more + 8 stand-ins + 1 host quote check) x 2 rounds + report 1.
    expect(planWorkflowCalls(workflowTemplate('discover')).perStep).toEqual({
      brief: 1,
      scout: 1,
      find: 36,
      verify: 132,
      report: 1
    })
    // One builder and two reviewers, repeated until approved: 3 calls a round, up to 3 rounds.
    const buildThenReview = spec({
      title: 'Build then review',
      steps: [
        { id: 'build', kind: 'do', agents: [{ route: 'claude' }] },
        {
          id: 'review',
          kind: 'review',
          agents: [{ route: 'codex' }, { route: 'grok' }],
          inputs: ['build']
        }
      ],
      repeat: { do: 'build', review: 'review', until: 'approved', maxRounds: 3 }
    })
    expect(planWorkflowCalls(buildThenReview).total).toBe(3 + 2 * 3)
  })

  it('reads back in plain English', () => {
    expect(describeWorkflow(spec(researchCriticsFinal))).toEqual([
      'Research: 4 agents work in parallel.',
      'Critics: 2 agents review in parallel using Research.',
      'Final: 1 agent writes the final answer using Research and Critics.',
      'Up to 7 agent calls.'
    ])
  })
})
