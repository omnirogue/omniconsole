import { describe, expect, it } from 'vitest'
import { compileNextStepChain } from './next-step-compile'
import { NEXT_STEP_TEMPLATE_IDS, nextStepTemplateDraft } from './next-step-templates'

let keys = 0
const input = { agents: ['claude', 'codex'] as const, mintKey: () => `k${(keys += 1)}` }

describe('next-step templates', () => {
  it('are compositions of the same actions and compile like a hand-made draft', () => {
    for (const id of NEXT_STEP_TEMPLATE_IDS) {
      const draft = nextStepTemplateDraft(id, input)
      expect(draft).not.toBeNull()
      const { steps, problems } = compileNextStepChain({
        draft: draft!,
        chainId: 'chn_t',
        workspacePath: '/w',
        sessionLabel: 's',
        defaultNote: 'n',
        now: 1,
        mintStepId: (position) => `step_${position}`,
        mintOperationId: () => 'op_00000000'
      })
      expect(problems).toEqual([])
      expect(steps.length).toBeGreaterThan(0)
    }
    const council = nextStepTemplateDraft('council', input)!
    expect(
      council.recipients.map((r) => (r.kind === 'agent' ? [r.agent, r.presetId] : null))
    ).toEqual([
      ['claude', 'review'],
      ['codex', 'review'],
      ['claude', 'review']
    ])
    expect(council.after.map((s) => (s.kind === 'agent' ? s.presetId : 'person'))).toEqual([
      'synthesize'
    ])
    expect(
      nextStepTemplateDraft('research-plan-create', input)!.after.map(
        (s) => s.kind === 'agent' && s.presetId
      )
    ).toEqual(['plan', 'implement'])
    expect(nextStepTemplateDraft('council', { agents: [], mintKey: () => 'x' })).toBeNull()
  })
})
