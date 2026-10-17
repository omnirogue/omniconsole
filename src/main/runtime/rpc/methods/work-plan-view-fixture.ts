import { normalizeSessionChain, type SessionChain } from '../../../../shared/session-chain-types'
import { reviseSessionOutcomeSet } from '../../../../shared/session-outcome-state'

export function conversationPlanFixture(workspacePath = '/workspace'): SessionChain {
  const steps = [1, 2, 3].map((index) => ({
    id: `s${index}`,
    agent: 'claude',
    prompt: 'Plan the work',
    presetId: 'plan',
    planNodeId: 'plan',
    group: 'authored-group',
    planVersion: 1,
    status: 'queued'
  }))
  const outcomeSet = reviseSessionOutcomeSet(
    undefined,
    {
      expectedRevision: 0,
      source: 'user',
      outcomes: [
        {
          id: 'outcome',
          title: 'Plan the work',
          outputKind: 'plan',
          finish: 'complete',
          stepIds: steps.map((step) => step.id),
          actions: [],
          dependsOn: [],
          conditions: [{ id: 'file', kind: 'file', target: 'plan.json', label: 'A useful plan' }]
        }
      ]
    },
    { owner: 'execution-host', hostId: 'local', epoch: 'epoch', state: 'owned' },
    1
  )
  outcomeSet.attempts = [1, 2, 3].map((index) => ({
    id: `attempt${index}`,
    outcomeId: 'outcome',
    outcomeRevision: 1,
    actionId: `step_s${index}`,
    actionKey: `action${index}`,
    planVersion: 1,
    state: index < 3 ? 'running' : 'prepared',
    taskId: `task${index}`,
    dispatchId: `dispatch${index}`,
    startedAt: 1,
    updatedAt: 1
  }))
  return normalizeSessionChain({
    id: 'chain',
    workspacePath,
    worktreeId: 'folder:1',
    hostId: 'local',
    sourcePaneKey: 'source:leaf-1',
    sourceRowKey: 'source',
    auto: true,
    steps,
    outcomeSet,
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 2
  })!
}
