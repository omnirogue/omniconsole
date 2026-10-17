import { describe, expect, it, vi } from 'vitest'
import { nextOutcomeTeamPlanLaunchInstruction } from '../../shared/next-outcome-team-plan-instructions'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeCommit } from '../../shared/session-outcome-types'
import { reconcileSessionOutcomeSteps } from './session-outcome-revision'
import { expandSessionOutcomeTeamPlan } from './session-outcome-team-plan'

const work = 'Ship the billing export with tests'
const consentedAt = '2026-09-15T18:00:00.000Z'
const authority = `${nextOutcomeTeamPlanLaunchInstruction('omni', consentedAt)}\n\n${work}.`
const base: SessionChain = {
  id: 'chain',
  workspacePath: '/work',
  worktreeId: 'repo::/work',
  hostId: 'local',
  sourcePaneKey: 'pane',
  sourceRowKey: 'row',
  auto: true,
  steps: [{ id: 'other_step', outcomeId: 'other', agent: 'codex', prompt: work, status: 'queued' }],
  currentIndex: 0,
  state: 'waiting',
  createdAt: 1,
  updatedAt: 1
}
const input: SessionOutcomeCommit = {
  source: 'ai',
  expectedRevision: 0,
  expectedSourcePrompt: authority,
  outcomes: [
    {
      id: 'ship',
      title: 'Ship billing export',
      finish: 'complete',
      dependsOn: [],
      conditions: [{ id: 'file', kind: 'file', target: '/work/out.md' }],
      actions: []
    }
  ],
  team: {
    outcomes: [
      {
        outcomeId: 'ship',
        steps: [
          {
            kind: 'agent',
            id: 'build',
            agent: 'codex',
            model: 'gpt-5.6-terra',
            effort: 'high',
            instruction: work
          },
          {
            kind: 'review',
            id: 'review',
            reviewers: [{ agent: 'claude', model: 'opus' }],
            maxRounds: 1,
            instruction: work
          }
        ]
      }
    ]
  }
}
const probe = {
  success: true,
  catalogOrigin: 'probe' as const,
  models: [
    { id: 'gpt-5.6-terra', label: 'Terra', thinkingLevels: [{ id: 'high', label: 'High' }] },
    { id: 'opus', label: 'Opus', thinkingLevels: [{ id: 'high', label: 'High' }] }
  ]
}

describe('host expansion of an agent-planned team', () => {
  it('compiles the plan against live probes and records the launch consent', async () => {
    const discover = vi.fn().mockResolvedValue(probe)
    const expanded = await expandSessionOutcomeTeamPlan({
      base,
      input,
      authorityInstruction: authority,
      discover,
      now: 42
    })
    expect(discover).toHaveBeenCalledWith('id:repo::/work', 'codex')
    expect(discover).toHaveBeenCalledWith('id:repo::/work', 'claude')
    expect(expanded.base.steps.map((step) => step.id)).toEqual([
      'other_step',
      'ship_build',
      'ship_review_reviewer-claude-1_round-1'
    ])
    expect(expanded.input.teamPlanning).toEqual({
      source: 'agent-planned',
      consentedAt,
      committedAt: 42
    })
    expect(expanded.input.outcomes[0]!.stepIds).toEqual([
      'ship_build',
      'ship_review_reviewer-claude-1_round-1'
    ])
    const reconciled = reconcileSessionOutcomeSteps(
      { ...expanded.base, steps: expanded.base.steps.slice(1) },
      undefined,
      expanded.input,
      authority
    )
    expect(reconciled.steps).toHaveLength(2)
  })

  it('refuses without launch consent, from a user commit, or on an unprobed model', async () => {
    const discover = vi.fn().mockResolvedValue(probe)
    const run = (overrides: Partial<Parameters<typeof expandSessionOutcomeTeamPlan>[0]>) =>
      expandSessionOutcomeTeamPlan({
        base,
        input,
        authorityInstruction: authority,
        discover,
        now: 1,
        ...overrides
      })
    await expect(run({ authorityInstruction: `${work}.` })).rejects.toThrow('Plan the team')
    await expect(run({ input: { ...input, source: 'user' } })).rejects.toThrow('source agent')
    await expect(
      run({ discover: vi.fn().mockRejectedValue(new Error('offline')) })
    ).rejects.toThrow('not usable on this host')
  })

  it('never keeps a caller-supplied consent claim and never lets AI add team steps without consent', async () => {
    const claimed = {
      ...input,
      team: undefined,
      teamPlanning: { source: 'agent-planned' as const, consentedAt, committedAt: 1 }
    }
    const stripped = await expandSessionOutcomeTeamPlan({
      base,
      input: claimed,
      authorityInstruction: authority,
      discover: vi.fn(),
      now: 1
    })
    expect(stripped.input.teamPlanning).toBeUndefined()
    const expanded = await expandSessionOutcomeTeamPlan({
      base,
      input,
      authorityInstruction: authority,
      discover: vi.fn().mockResolvedValue(probe),
      now: 1
    })
    const { teamPlanning: _dropped, ...unplanned } = expanded.input
    expect(() =>
      reconcileSessionOutcomeSteps(expanded.base, undefined, unplanned, authority)
    ).toThrow('AI cannot add or rewrite steps')
    expect(() =>
      reconcileSessionOutcomeSteps(expanded.base, undefined, expanded.input, `${work}.`)
    ).toThrow('AI cannot add or rewrite steps')
  })
})
