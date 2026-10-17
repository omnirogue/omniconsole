import { describe, expect, it } from 'vitest'
import {
  localWorkflowFindRequestSchema,
  localWorkflowFindSpec
} from './local-workflow-find-request'
import { findJudgeStep, findOptionsStep } from './workflow-graph-find'
import { validateWorkflowSpec } from './workflow-graph-validate'
import { normalizeWorkflowSpec } from './workflow-graph-normalize'
import type { WorkflowRoute } from './workflow-graph'

const ROUTES: WorkflowRoute[] = ['claude', 'codex']

describe('the Find the best spec a command asks for', () => {
  it('builds what the Options panel builds', () => {
    const spec = localWorkflowFindSpec(
      { prompt: 'Ad hooks', count: 40, keep: 20, top: 3 },
      ROUTES,
      []
    )
    expect(spec.find).toEqual({ count: 40, top: 3, keep: 20 })
    expect(validateWorkflowSpec(spec, { available: ROUTES }).problems).toEqual([])
    const versions = localWorkflowFindSpec(
      { prompt: 'Landing', versions: true, count: 3 },
      ROUTES,
      []
    )
    expect(versions.find).toMatchObject({ versions: true, count: 3 })
    expect(findOptionsStep(versions)!.agents).toHaveLength(3)
    // A list is judged as given, so it never writes versions.
    const listed = localWorkflowFindSpec(
      { prompt: 'Repos', items: ['a', 'b'], versions: true },
      ROUTES,
      []
    )
    expect(listed.find).toMatchObject({ items: ['a', 'b'] })
    expect(listed.find).not.toHaveProperty('versions')
  })

  it('refuses a list with complete versions on the wire, not only in the CLI', () => {
    expect(
      localWorkflowFindRequestSchema.safeParse({ prompt: 'x', items: ['a', 'b'], versions: true })
        .success
    ).toBe(false)
  })

  it("judges by a rubric from the library, the person's saved ones included, and their words", () => {
    const saved = [
      { name: 'Our replies', instructions: '- Kind\n- Correct', kind: 'reply' as const }
    ]
    const judge = (rubric?: string, good?: string) =>
      findJudgeStep(
        localWorkflowFindSpec(
          { prompt: 'x', ...(rubric ? { rubric } : {}), ...(good ? { good } : {}) },
          ROUTES,
          saved
        )
      )!.instruction
    expect(judge('ad copy')).toMatch(/^Rubric: Ad copy\nJudge ad copy/)
    expect(judge('Our replies', '- Under 90 words')).toBe(
      'Rubric: Our replies\n- Kind\n- Correct\n\nReview focus:\n- Under 90 words'
    )
    expect(judge(undefined, '- Cheap\n- Fast')).toBe('- Cheap\n- Fast')
    expect(() => judge('Nope')).toThrow(/No rubric is named "Nope"\. Choose one of: .*Ad copy/)
  })

  it('carries the import receipt (four rows, one skipped) from the request into the spec, independent of itemDetails', () => {
    const receipt = {
      read: 4,
      imported: 3,
      skipped: [{ line: 2, reason: 'no title' }],
      merged: 0
    }
    const spec = localWorkflowFindSpec(
      { prompt: 'Repos', items: ['Alpha', 'Beta', 'Gamma'], importReceipt: receipt },
      ROUTES,
      []
    )
    // Title-only items (no detail/url) keep the receipt too: it is independent of itemDetails.
    expect(spec.find).not.toHaveProperty('itemDetails')
    expect(spec.find?.importReceipt).toEqual(receipt)
    expect(spec.find?.importMerged).toBe(0)
    // A re-normalize of the same spec never fabricates or drops the receipt it was actually given.
    const again = normalizeWorkflowSpec(JSON.parse(JSON.stringify(spec)), ROUTES)
    expect(again.find?.importReceipt).toEqual(receipt)
    // Typing a list by hand (no importReceipt on the request) gets no fabricated receipt.
    const typed = localWorkflowFindSpec({ prompt: 'Repos', items: ['Alpha', 'Beta'] }, ROUTES, [])
    expect(typed.find).not.toHaveProperty('importReceipt')
  })
})
