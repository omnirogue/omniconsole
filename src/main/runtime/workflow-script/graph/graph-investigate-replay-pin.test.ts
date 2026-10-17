import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { WorkflowSpec } from '../../../../shared/workflow-graph'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { planWorkflowCalls } from '../../../../shared/workflow-graph-topology'
import type { GraphCall } from './graph-plan-types'
import { decideAnswer, decideSpec } from './graph-decide-test-fixtures'
import { drive, text } from './graph-test-harness'

// Taken on main-next 65047d05b, before Investigate: these runs must replay byte for byte.
const RESEARCH_PANEL = 'b1b16e4173f4604fb20574234d2d1f2fe9265f4b20fd23f1779cacf11f8062ed'
const COUNCIL = '83597cb8eb6d5a7131a6b8e8142f27fab554937934fea8e81ec8c4611bd7ea06'
const DECIDE = '8e1d6ce8449bf09995e02688bdb6419a15bd10d54414bd97b32f717c06d0666f'

const ROUTES = ['claude', 'codex', 'grok'] as const

const panelAnswer = (call: GraphCall) =>
  call.stepId === 'critics'
    ? text(`Critique ${call.agentIndex}.\nVERDICT: FAIL`)
    : text(`${call.stepId} answer ${call.agentIndex}`)

const councilAnswer = (call: GraphCall) =>
  call.stepId === 'rank'
    ? { ...text('FINAL RANKING:\n1. Response B\n2. Response A\n3. Response C'), unsure: true }
    : text(`${call.stepId} answer ${call.agentIndex}`)

/** Every call's identity, prompt, schema and host request, the bound, and the final answer. */
function fingerprint(spec: WorkflowSpec, answer: (call: GraphCall) => unknown): string {
  const plan = drive(spec, answer)
  expect(plan.outcome?.state).toBe('completed')
  const hash = createHash('sha256')
  for (const call of plan.calls) {
    const request = call.screen ?? call.facts ?? call.jev ?? call.check ?? call.evidence ?? null
    hash.update(
      JSON.stringify([
        call.id,
        call.seatId,
        call.round,
        call.itemKey ?? null,
        call.agentIndex,
        call.dependencies,
        call.prompt,
        call.schema,
        request && createHash('sha256').update(JSON.stringify(request)).digest('hex')
      ])
    )
  }
  const { total, perStep } = planWorkflowCalls(spec)
  hash.update(JSON.stringify({ total, perStep, outcome: plan.outcome }))
  return hash.digest('hex')
}

describe('specs from before Investigate replay unchanged', () => {
  it('replays the Research panel template', () => {
    expect(fingerprint(workflowTemplate('research-panel', ROUTES), panelAnswer)).toBe(
      RESEARCH_PANEL
    )
  })

  it('replays the Council template', () => {
    expect(fingerprint(workflowTemplate('council', ROUTES), councilAnswer)).toBe(COUNCIL)
  })

  it('replays the Decide template', () => {
    expect(fingerprint(decideSpec(), decideAnswer())).toBe(DECIDE)
  })
})
