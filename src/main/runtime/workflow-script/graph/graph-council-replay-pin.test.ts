import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { WorkflowSpec } from '../../../../shared/workflow-graph'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { planWorkflowCalls } from '../../../../shared/workflow-graph-topology'
import type { GraphCall } from './graph-plan-types'
import { drive, text } from './graph-test-harness'

// Digests taken on the base branch (feat/council-final-check-0923 at 199e4e4ea) before Decide.
const LEGACY_DIGEST = '034a464711b2a23f41fad0b33b995ce70aa25407ed3ac9344e5347aef4697a7f'
const FINAL_CHECK_DIGEST = 'b3caab1765c545d30c26d8eb8641d6166d79959aeafa7edb487d208345551d64'

/** A Council spec as runs from before the final check froze it: no finalCheck field. */
const LEGACY: WorkflowSpec = {
  version: 1,
  title: 'Council',
  template: 'council',
  steps: [
    {
      id: 'answer',
      kind: 'do',
      title: 'First opinions',
      instruction: '',
      agents: [{ route: 'claude' }, { route: 'codex' }, { route: 'grok' }],
      inputs: []
    },
    {
      id: 'rank',
      kind: 'rank',
      title: 'Peer rankings',
      instruction: '',
      agents: [{ route: 'codex' }, { route: 'grok' }, { route: 'claude' }],
      inputs: ['answer'],
      jev: { method: 'auto', only: true }
    },
    {
      id: 'chair',
      kind: 'synthesize',
      title: "Chairman's answer",
      instruction: 'Write the final answer.',
      agents: [{ route: 'claude' }],
      inputs: ['answer', 'rank']
    }
  ]
}

const answer = (call: GraphCall) =>
  call.stepId === 'answer'
    ? text(`Opinion ${call.agentIndex}`)
    : call.stepId === 'chair'
      ? text('Chair answer')
      : { ...text('FINAL RANKING:\n1. Response B\n2. Response A\n3. Response C'), unsure: true }

/** Every call a run makes, exactly as the durable store would key and prompt it. */
function digest(spec: WorkflowSpec): string {
  const plan = drive(spec, answer)
  const calls = plan.calls.map((call) => [
    call.id,
    call.seatId,
    call.prompt,
    call.dependencies,
    call.jev ?? null
  ])
  // The bound as the base had it: agentTotal and hostTotal came later and only restate total.
  const { total, perStep } = planWorkflowCalls(spec)
  const body = JSON.stringify({ calls, bound: { total, perStep }, final: plan.outcome })
  return createHash('sha256').update(body).digest('hex')
}

describe('Council replay stays byte-identical', () => {
  it('replays a legacy Council spec with the same calls and prompts', () => {
    expect(digest(LEGACY)).toBe(LEGACY_DIGEST)
  })

  it('replays the final-check Council template with the same calls and prompts', () => {
    expect(digest(workflowTemplate('council', ['claude', 'codex', 'grok']))).toBe(
      FINAL_CHECK_DIGEST
    )
  })
})
