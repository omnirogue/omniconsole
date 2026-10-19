import { samWorkPlan } from './sal-work-plan'
import { workPlanFixtureContext } from '../work-plan-context'
import { compileWorkPlanExecution } from '../../../work-plan-compile'
import { reviseSessionOutcomeSet } from '../../../session-outcome-state'
import type { SessionChain } from '../../../session-chain-types'

export function goldenChain(plan = samWorkPlan()): SessionChain {
  const result = compileWorkPlanExecution(plan, {
    ...workPlanFixtureContext(),
    chainId: 'golden',
    workspacePath: '/workspace'
  })
  return {
    id: 'golden',
    workspacePath: '/workspace',
    worktreeId: 'folder',
    hostId: null,
    sourcePaneKey: 'chat',
    sourceRowKey: 'chat',
    auto: true,
    steps: result.steps,
    currentIndex: 0,
    state: 'waiting',
    createdAt: 0,
    updatedAt: 0,
    end: result.draft.end,
    outcomeSet: reviseSessionOutcomeSet(
      undefined,
      { expectedRevision: 0, outcomes: result.outcomes, source: 'user' },
      { owner: 'execution-host', hostId: 'local', epoch: 'test', state: 'owned' },
      0
    )
  }
}
