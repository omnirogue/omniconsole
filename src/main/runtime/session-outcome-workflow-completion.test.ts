import { expect, it, vi } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeService } from './session-outcome-service'
import { workflowProofFixture } from './session-outcome-workflow-proof-fixture'
import { projectSessionOutcomeStageCompletion } from './session-outcome-workflow-completion'
import { closedSessionOutcomeStages } from './session-outcome-workflow-projection'
import { sessionOutcomeAmendmentSources } from './session-outcome-workflow-sources'
import { compileSessionOutcomeWorkflow } from './session-outcome-workflow-compile'

function fixture() {
  const { workflow, jobs } = workflowProofFixture()
  workflow.activations = workflow.receipts!.map((receipt) => ({
    jobId: receipt.jobId,
    state: 'started',
    dispatchId: receipt.dispatchId,
    runId: receipt.runId
  }))
  const chain = {
    id: 'progress',
    steps: [
      {
        id: 'producer',
        agent: 'codex',
        model: 'gpt-5.6-terra',
        effort: 'high',
        prompt: 'Build file.',
        status: 'queued'
      },
      {
        id: 'astra',
        agent: 'codex',
        model: 'gpt-6-astra',
        effort: 'high',
        prompt: 'Review file.',
        status: 'queued',
        review: { groupId: 'review', round: 1, maxRounds: 1, reviewerId: 'astra' }
      },
      {
        id: 'sol',
        agent: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
        prompt: 'Review source.',
        status: 'queued',
        review: { groupId: 'review', round: 1, maxRounds: 1, reviewerId: 'sol' }
      }
    ],
    currentIndex: 0,
    outcomeSet: {
      schemaVersion: 1,
      revision: 1,
      updatedAt: 1,
      removals: [],
      attempts: [],
      completedSteps: [],
      workflow,
      continuation: {
        owner: 'execution-host',
        taskId: 'btk_root',
        principal: 'person',
        hostId: 'local',
        epoch: 'epoch',
        state: 'owned'
      },
      outcomes: [
        {
          id: 'build',
          title: 'Build and review',
          finish: 'my-review',
          stepIds: ['producer', 'astra', 'sol'],
          actions: [],
          dependsOn: [],
          conditions: [{ id: 'file', kind: 'file', target: 'result.md' }],
          revision: 1,
          status: 'pending',
          evidence: []
        }
      ]
    }
  } as unknown as SessionChain
  const save = vi.fn((next: SessionChain) => next)
  const service = { save } as unknown as SessionOutcomeService
  return { chain, workflow, jobs, service, save }
}
it('retains an accepted producer while its review loop and outcome remain pending', () => {
  const { chain, workflow, jobs, service } = fixture()
  const before = JSON.stringify(workflow.receipts)
  const projected = projectSessionOutcomeStageCompletion(service, chain, workflow, [], jobs)
  expect(projected.outcomeSet!.completedSteps).toEqual(['producer'])
  expect(projected.steps.map((step) => step.status)).toEqual(['launched', 'queued', 'queued'])
  expect(projected.currentIndex).toBe(1)
  expect(projected.outcomeSet!.outcomes[0]!.status).toBe('pending')
  expect(projected.outcomeSet!.outcomes[0]!.evidence).toEqual([])
  expect(JSON.stringify(workflow.receipts)).toBe(before)
})
it('does not rerun the accepted producer when remaining reviews are recompiled after an edit', () => {
  const { chain, workflow, jobs, service } = fixture()
  const projected = projectSessionOutcomeStageCompletion(service, chain, workflow, [], jobs)
  const remaining = projected.steps.filter(
    (step) => !projected.outcomeSet!.completedSteps!.includes(step.id)
  )
  const sources = sessionOutcomeAmendmentSources(projected, remaining, [workflow])
  const compiled = compileSessionOutcomeWorkflow({ ...projected, steps: remaining }, sources)
  expect(compiled.bindings[0]!.stepIds).toEqual(['astra', 'sol'])
  expect(compiled.predecessorReceipts).toEqual([
    expect.objectContaining({
      mode: 'review-source',
      job_id: workflow.receipts![0]!.jobId,
      receipt_event_id: workflow.receipts![0]!.eventId,
      fingerprint: workflow.receipts![0]!.fingerprint
    })
  ])
})
it('replays producer progress without another persistence write', () => {
  const { chain, workflow, jobs, service, save } = fixture()
  const projected = projectSessionOutcomeStageCompletion(service, chain, workflow, [], jobs)
  save.mockClear()
  expect(projectSessionOutcomeStageCompletion(service, projected, workflow, [], jobs)).toBe(
    projected
  )
  expect(save).not.toHaveBeenCalled()
})
it.each([
  'absent',
  'report',
  'revision',
  'digest',
  'attempt',
  'lease',
  'task',
  'model',
  'action',
  'activation'
] as const)('refuses partial producer completion with changed %s authority', (change) => {
  const { chain, workflow, jobs, service } = fixture()
  chain.outcomeSet!.completedSteps = ['producer']
  if (change === 'absent') {
    jobs.splice(0, 1)
  }
  if (change === 'report') {
    jobs[0]!.policy.workflow.hub_projection!.verification_report_id = 'other'
  }
  if (change === 'revision') {
    jobs[0]!.policy.workflow.hub_projection!.revision_id = 'other'
  }
  if (change === 'digest') {
    jobs[0]!.policy.workflow.digest = 'f'.repeat(64)
  }
  if (change === 'attempt') {
    jobs[0]!.attempt = 2
  }
  if (change === 'lease') {
    jobs[0]!.lease_generation = 2
  }
  if (change === 'task') {
    jobs[0]!.task_id = 'btk_another'
  }
  if (change === 'model') {
    jobs[0]!.model = 'another'
  }
  if (change === 'action') {
    jobs[0]!.policy.workflow.action = 'review'
  }
  if (change === 'activation') {
    workflow.activations[0]!.runId = 'run_other'
  }
  const projected = projectSessionOutcomeStageCompletion(service, chain, workflow, [], jobs)
  expect(projected.outcomeSet!.completedSteps).not.toContain('producer')
})
it('does not treat a retained receipt alone as current acceptance', () => {
  const { chain, workflow, service } = fixture()
  expect(
    projectSessionOutcomeStageCompletion(service, chain, workflow, []).outcomeSet!.completedSteps
  ).toEqual([])
})
it('keeps accepted folder producer progress without inventing a Git candidate', () => {
  const { chain, workflow, jobs, service } = fixture()
  workflow.receipts![0]!.candidateSha = null
  workflow.receipts![0]!.branch = null
  workflow.receipts![0]!.prUrl = null
  expect(
    projectSessionOutcomeStageCompletion(service, chain, workflow, [], jobs).outcomeSet!
      .completedSteps
  ).toEqual(['producer'])
})
it('does not clear current evidence or status for a retired fully superseded stage', () => {
  const { chain, workflow, jobs, service, save } = fixture()
  workflow.retired = true
  const next = structuredClone(workflow)
  next.retired = false
  next.operationId = 'replacement'
  next.stages[0]!.stepIds = ['newproducer', 'newastra', 'newsol']
  chain.steps = chain.steps.map((step) =>
    step.kind === 'handoff' ? step : { ...step, id: `new${step.id}`, status: 'launched' }
  )
  chain.outcomeSet!.workflowHistory = [workflow]
  chain.outcomeSet!.workflow = next
  chain.outcomeSet!.completedSteps = next.stages[0]!.stepIds
  chain.currentIndex = chain.steps.length
  const outcome = chain.outcomeSet!.outcomes[0]!
  outcome.stepIds = next.stages[0]!.stepIds
  outcome.status = 'satisfied'
  outcome.evidence = [{ id: 'current_evidence' }] as never
  expect(projectSessionOutcomeStageCompletion(service, chain, workflow, [], jobs)).toBe(chain)
  expect(save).not.toHaveBeenCalled()
  expect(outcome.evidence).toEqual([{ id: 'current_evidence' }])
})
it('does not let an older binding revoke a newer binding with the same authored IDs', () => {
  const { chain, workflow, jobs, service } = fixture()
  const next = structuredClone(workflow)
  next.operationId = 'replacement'
  chain.outcomeSet!.workflowHistory = [workflow]
  chain.outcomeSet!.workflow = next
  chain.outcomeSet!.completedSteps = ['producer', 'astra', 'sol']
  chain.outcomeSet!.outcomes[0]!.evidence = [{ id: 'new_evidence' }] as never
  const projected = projectSessionOutcomeStageCompletion(service, chain, workflow, [], jobs)
  expect(projected.outcomeSet!.completedSteps).toEqual(['producer', 'astra', 'sol'])
  expect(projected.outcomeSet!.outcomes[0]!.evidence).toEqual([{ id: 'new_evidence' }])
})
it('does invalidate evidence when a retired stage still owns required pending reviews', () => {
  const { chain, workflow, jobs, service } = fixture()
  workflow.retired = true
  chain.outcomeSet!.outcomes[0]!.evidence = [{ id: 'old_evidence' }] as never
  const projected = projectSessionOutcomeStageCompletion(service, chain, workflow, [], jobs)
  expect(projected.outcomeSet!.completedSteps).toEqual(['producer'])
  expect(projected.outcomeSet!.outcomes[0]!.evidence).toEqual([])
  expect(projected.outcomeSet!.evidenceHistory).toEqual([{ id: 'old_evidence' }])
})
it('marks the entire authored group only after canonical closure', () => {
  const { chain, workflow, jobs, service } = fixture()
  const closed = closedSessionOutcomeStages(workflow, jobs)
  const projected = projectSessionOutcomeStageCompletion(service, chain, workflow, closed, jobs)
  expect(projected.outcomeSet!.completedSteps).toEqual(['producer', 'astra', 'sol'])
})

it('preserves current evidence when only the accepted producer remains from a retired review group', () => {
  const { chain, workflow, jobs, service } = fixture()
  workflow.retired = true
  const next = structuredClone(workflow)
  next.operationId = 'new_reviews'
  next.stages[0]!.stepIds = ['newastra', 'newsol']
  chain.steps = chain.steps.map((step) =>
    step.id === 'producer' ? step : { ...step, id: `new${step.id}` }
  )
  chain.outcomeSet!.workflowHistory = [workflow]
  chain.outcomeSet!.workflow = next
  chain.outcomeSet!.completedSteps = ['producer', 'newastra', 'newsol']
  chain.outcomeSet!.outcomes[0]!.stepIds = ['producer', 'newastra', 'newsol']
  chain.outcomeSet!.outcomes[0]!.evidence = [{ id: 'current_evidence' }] as never
  const projected = projectSessionOutcomeStageCompletion(service, chain, workflow, [], jobs)
  expect(projected.outcomeSet!.completedSteps).toEqual(['producer', 'newastra', 'newsol'])
  expect(projected.outcomeSet!.outcomes[0]!.evidence).toEqual([{ id: 'current_evidence' }])
})
it.each([false, true])(
  'checks current action binding relevance before invalidating evidence (superseded=%s)',
  (superseded) => {
    const { chain, workflow, jobs, service } = fixture()
    workflow.retired = true
    workflow.stages[0]!.stepIds = []
    workflow.stages[0]!.actionIds = ['action']
    chain.steps = []
    chain.outcomeSet!.outcomes[0]!.stepIds = []
    chain.outcomeSet!.outcomes[0]!.actions = [{ id: superseded ? 'newaction' : 'action' }] as never
    chain.outcomeSet!.outcomes[0]!.evidence = [{ id: 'current_evidence' }] as never
    const projected = projectSessionOutcomeStageCompletion(service, chain, workflow, [], jobs)
    expect(projected.outcomeSet!.outcomes[0]!.evidence).toEqual(
      superseded ? [{ id: 'current_evidence' }] : []
    )
  }
)
