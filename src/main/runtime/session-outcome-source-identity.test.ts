import { expect, it } from 'vitest'
import { normalizeSessionChainStep, type SessionChain } from '../../shared/session-chain-types'
import { reconcileSessionOutcomeSteps } from './session-outcome-revision'
import { sessionOutcomeAmendmentSources } from './session-outcome-workflow-sources'
import { workflowProofFixture } from './session-outcome-workflow-proof-fixture'
it('uses the replaced physical chain identity while retaining the separate renderer editor identity', () => {
  const { workflow } = workflowProofFixture()
  const old = {
    id: 'chain',
    workspacePath: '/workspace',
    worktreeId: 'tree',
    hostId: 'local',
    sourcePaneKey: 'pane',
    sourceRowKey: 'row',
    auto: true,
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1,
    steps: [
      {
        id: 'producer',
        editorStepId: 'renderer_execute_17',
        agent: 'codex',
        model: 'gpt-5.6-terra',
        prompt: 'Old task',
        status: 'launched'
      }
    ],
    outcomeSet: {
      workflow,
      schemaVersion: 1,
      revision: 1,
      updatedAt: 1,
      removals: [],
      attempts: [],
      completedSteps: ['producer'],
      continuation: { owner: 'execution-host', hostId: 'local', epoch: 'epoch', state: 'owned' },
      outcomes: [
        {
          id: 'build',
          title: 'Build',
          finish: 'my-review',
          stepIds: ['producer'],
          actions: [],
          dependsOn: [],
          conditions: [{ id: 'file', kind: 'file', target: 'report.md' }],
          revision: 1,
          evidence: [],
          status: 'pending'
        }
      ]
    }
  } as unknown as SessionChain
  const reconciled = reconcileSessionOutcomeSteps(
    { ...old, steps: old.steps.map((step) => ({ ...step, prompt: 'Edited task' })) },
    old,
    { source: 'user', expectedRevision: 1, outcomes: old.outcomeSet!.outcomes }
  )
  const replacement = reconciled.steps[0]!
  expect(replacement).toMatchObject({
    replacedStepId: 'producer',
    editorStepId: 'renderer_execute_17'
  })
  expect(replacement.id).not.toBe('producer')
  const chain = {
    ...old,
    steps: reconciled.steps.map((step) => normalizeSessionChainStep(step)!),
    outcomeSet: {
      ...old.outcomeSet,
      outcomes: reconciled.input.outcomes.map((outcome) => ({
        ...outcome,
        revision: 2,
        evidence: [],
        status: 'pending'
      }))
    }
  } as SessionChain
  expect(chain.steps[0]).toMatchObject({
    replacedStepId: 'producer',
    editorStepId: 'renderer_execute_17'
  })
  expect(
    sessionOutcomeAmendmentSources(chain, chain.steps, [workflow]).get(replacement.id)?.receipt
      .jobId
  ).toBe(workflow.receipts![0]!.jobId)
})
