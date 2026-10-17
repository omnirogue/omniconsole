import { expect, it } from 'vitest'
import { compileNextOutcomeTeamPlan } from './next-outcome-team-plan-compile'
import { summarizeSessionChainTeam } from './session-chain-team'

const work = 'Ship the billing export with tests'

it('collapses rounds and repairs into planned seats and keeps the consent record', () => {
  const { steps } = compileNextOutcomeTeamPlan({
    team: {
      outcomes: [
        {
          outcomeId: 'ship',
          steps: [
            {
              kind: 'agent',
              id: 'api',
              agent: 'codex',
              model: 'gpt-5.6-terra',
              instruction: work,
              parallelGroup: 'build'
            },
            {
              kind: 'agent',
              id: 'ui',
              agent: 'claude',
              model: 'sonnet',
              instruction: work,
              parallelGroup: 'build'
            },
            {
              kind: 'agent',
              id: 'integrate',
              agent: 'codex',
              model: 'gpt-5.6-terra',
              instruction: work
            },
            {
              kind: 'review',
              id: 'review',
              reviewers: [
                { agent: 'codex', model: 'gpt-6-astra' },
                { agent: 'claude', model: 'opus' }
              ],
              maxRounds: 3,
              instruction: work
            },
            {
              kind: 'agent',
              id: 'repair',
              agent: 'codex',
              model: 'gpt-5.6-terra',
              instruction: work
            }
          ]
        }
      ]
    },
    outcomes: [
      {
        id: 'ship',
        title: 'Ship',
        finish: 'complete',
        dependsOn: [],
        conditions: [{ id: 'file', kind: 'file', target: '/work/out.md' }],
        actions: []
      }
    ],
    chainId: 'chain',
    workspacePath: '/work',
    sessionLabel: 'Ship'
  })
  const planning = {
    source: 'agent-planned' as const,
    consentedAt: '2026-09-15T18:00:00.000Z',
    committedAt: 1
  }
  const summary = summarizeSessionChainTeam({ steps, teamPlanning: planning })!
  expect(summary.planning).toEqual(planning)
  expect(summary.counts).toEqual({ producer: 1, worker: 2, reviewer: 2, repair: 1 })
  expect(summary.maxRounds).toBe(3)
  expect(summary.parallelGroups).toEqual(['parallel_ship_build'])
  const reviewer = summary.seats.find(
    (seat) => seat.role === 'reviewer' && seat.agent === 'claude'
  )!
  expect(reviewer.stepIds).toHaveLength(3)
  expect(summary.seats.find((seat) => seat.role === 'repair')!.stepIds).toHaveLength(2)
  expect(
    summarizeSessionChainTeam({
      steps: [{ id: 's', agent: 'codex', prompt: 'x', status: 'queued' }]
    })
  ).toBeNull()
})
