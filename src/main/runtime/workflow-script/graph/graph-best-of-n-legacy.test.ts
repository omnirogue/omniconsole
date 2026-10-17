import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import saved from './fixtures/best-of-n-saved.json'
import { findJudgeStep, findOptionsStep } from '../../../../shared/workflow-graph-find'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { bestOfN } from './fixtures/best-of-n-legacy-builder'
import { validateWorkflowSpec } from '../../../../shared/workflow-graph-validate'
import { drive, text } from './graph-test-harness'

const ROUTES = ['claude', 'codex', 'grok'] as const

describe('saved Best of N before the Find merge', () => {
  it('keeps the literal saved spec and its replay byte for byte', () => {
    const spec = normalizeWorkflowSpec(saved, ROUTES)
    expect(JSON.stringify(spec)).toBe(JSON.stringify(saved))
    expect(normalizeWorkflowSpec(bestOfN(ROUTES), ROUTES)).toEqual(spec)
    expect(validateWorkflowSpec(spec, { available: ROUTES }).problems).toEqual([])
    expect(findOptionsStep(spec)).toBeUndefined()
    expect(findJudgeStep(spec)).toBeUndefined()
    const plan = drive(spec, (call) =>
      call.stepId === 'generate'
        ? text(`Version ${call.agentIndex + 1}`)
        : text('FINAL RANKING:\n1. Response D\n2. Response C\n3. Response B\n4. Response A')
    )
    expect(plan.find).toBeUndefined()
    expect(plan.outcome?.state).toBe('completed')
    expect(plan.outcome?.final?.markdown).toContain('## Ranked first:')
    expect(plan.outcome?.final?.markdown).toContain('Version 4')
    // Pins serialized calls, prompts, standings and report from the pre-merge runtime.
    expect(createHash('sha256').update(JSON.stringify(plan)).digest('hex')).toMatchInlineSnapshot(
      `"e5abcc61e84eb3c4ffccd844f61e73b6f4468040eb8dd73feb555ed861479a96"`
    )
  })
})
