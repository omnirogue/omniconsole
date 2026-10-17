import { quickDiscoverWorkflow } from '../../../../shared/workflow-graph-quick-discover'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { describe, expect, it } from 'vitest'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { drive, text } from './graph-test-harness'

const items = [
  {
    title: 'Missing guard',
    location: 'src/a.ts:1',
    severity: 'high',
    detail: 'A missing guard breaks reads.',
    excerpt: 'read()',
    trigger: 'missing input'
  },
  {
    title: 'Already guarded',
    location: 'src/b.ts:1',
    severity: 'low',
    detail: 'An existing guard.',
    excerpt: 'guard()',
    trigger: 'invalid input'
  }
]

describe('Quick Discover deterministic report', () => {
  it('keeps the actual verifier verdicts and ranking without a Report call', () => {
    const plan = drive(
      normalizeWorkflowSpec(quickDiscoverWorkflow(['claude', 'codex'], true)),
      (call) =>
        call.stepId === 'find'
          ? { items }
          : text(`VERDICT: ${call.id.includes('find.r1.2') ? 'FAIL' : 'PASS'}`)
    )
    expect(plan.calls.filter((call) => call.stepId === 'report')).toEqual([])
    expect(plan.outcome).toMatchObject({
      state: 'completed',
      final: { ranking: [{ key: 'find.r1.1', rank: 1 }] }
    })
    expect(plan.outcome?.final?.markdown).toContain(
      'confirmed'
    )
    expect(plan.outcome?.final?.markdown).toContain('refuted')
  })

  it('renders a single-family list and an empty list without a second call', () => {
    for (const found of [items, []]) {
      const plan = drive(workflowTemplate('quick-discover', ['claude']), () => ({ items: found }))
      expect(plan.calls).toHaveLength(1)
      expect(plan.outcome?.state).toBe('completed')
      expect(plan.outcome?.final?.markdown).toContain(
        found.length ? 'unverified' : 'No findings'
      )
    }
  })

  it('preserves findings as unverified when Verify fails', () => {
    const plan = drive(
      normalizeWorkflowSpec(quickDiscoverWorkflow(['claude', 'codex'], true)),
      (call) => (call.stepId === 'find' ? { items } : undefined)
    )
    expect(plan.outcome?.state).toBe('completed')
    expect(plan.outcome?.final?.markdown).toContain(
      'unverified'
    )
    expect(plan.outcome?.gaps.length).toBeGreaterThan(0)
  })
})
