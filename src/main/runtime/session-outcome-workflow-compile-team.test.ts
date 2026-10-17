import { expect, it } from 'vitest'
import { compileNextOutcomeTeamPlan } from '../../shared/next-outcome-team-plan-compile'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcome } from '../../shared/session-outcome-types'
import { compileSessionOutcomeWorkflow } from './session-outcome-workflow-compile'

const work = 'Ship the billing export with tests'

it('launches parallel implementers from one predecessor set and makes the next stage wait on all of them', () => {
  const planned = compileNextOutcomeTeamPlan({
    team: {
      outcomes: [
        {
          outcomeId: 'ship',
          steps: [
            { kind: 'agent', id: 'plan', agent: 'claude', model: 'opus', instruction: work },
            {
              kind: 'agent',
              id: 'api',
              agent: 'codex',
              model: 'gpt-5.6-terra',
              instruction: work,
              scope: 'src/api',
              parallelGroup: 'build'
            },
            {
              kind: 'agent',
              id: 'ui',
              agent: 'codex',
              model: 'gpt-5.6-sol',
              instruction: work,
              scope: 'src/ui',
              parallelGroup: 'build'
            },
            { kind: 'agent', id: 'integrate', agent: 'claude', model: 'sonnet', instruction: work },
            {
              kind: 'review',
              id: 'review',
              reviewers: [{ agent: 'codex', model: 'gpt-6-astra' }],
              maxRounds: 1,
              instruction: work
            }
          ]
        }
      ]
    },
    outcomes: [
      {
        id: 'ship',
        title: 'Ship billing export',
        finish: 'complete',
        dependsOn: [],
        conditions: [{ id: 'file', kind: 'file', target: '/repo/out.md' }],
        actions: []
      }
    ],
    chainId: 'chain',
    workspacePath: '/repo',
    sessionLabel: 'Ship billing export'
  })
  const chain: SessionChain = {
    id: 'chain',
    workspacePath: '/repo',
    worktreeId: 'tree',
    hostId: 'local',
    sourcePaneKey: 'source',
    sourceRowKey: 'source',
    auto: true,
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1,
    steps: planned.steps,
    outcomeSet: {
      schemaVersion: 1,
      revision: 1,
      updatedAt: 1,
      removals: [],
      attempts: [],
      continuation: { owner: 'execution-host', hostId: 'local', epoch: 'epoch', state: 'owned' },
      outcomes: planned.outcomes.map((outcome): SessionOutcome => ({
        ...outcome,
        revision: 1,
        status: 'pending',
        evidence: []
      }))
    }
  }
  const { stages } = compileSessionOutcomeWorkflow(chain)
  const byTitle = stages.map((stage) => ({
    key: stage.key,
    after: stage.after,
    group: stage.parallel_group
  }))
  const [plan, api, ui, integrate] = byTitle
  expect(stages).toHaveLength(4)
  expect(plan!.after).toEqual([])
  expect(api).toMatchObject({ after: [plan!.key], group: 'parallel_ship_build' })
  expect(ui).toMatchObject({ after: [plan!.key], group: 'parallel_ship_build' })
  expect(integrate!.after).toEqual([api!.key, ui!.key])
  expect(integrate!.group).toBeUndefined()
  expect(stages[3]!.loop?.participants).toEqual(['claude:sonnet', 'codex:gpt-6-astra'])
})
