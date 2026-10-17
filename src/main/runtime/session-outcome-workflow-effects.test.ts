import { publishSessionOutcomeMerge } from './session-outcome-workflow-publication'
import { beforeEach, expect, it, vi } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeService } from './session-outcome-service'
import { workflowProofFixture } from './session-outcome-workflow-proof-fixture'
import { advanceSessionOutcomeWorkflowEffects } from './session-outcome-workflow-effects'
import { executeSessionOutcomeHandoff } from './session-outcome-handoff'
import type * as Handoff from './session-outcome-handoff'
import { verifySessionOutcomeCondition } from './session-outcome-evidence'
import { materializeSessionOutcomeGitDeliverables } from './session-outcome-git-deliverables'
import { closedSessionOutcomeStages } from './session-outcome-workflow-projection'
vi.mock('./session-outcome-handoff', async (importOriginal) => ({
  ...(await importOriginal<typeof Handoff>()),
  executeSessionOutcomeHandoff: vi.fn(async () => {})
}))
vi.mock('./session-outcome-workflow-publication', () => ({
  publishSessionOutcomeMerge: vi.fn(async (_service, chain) => chain)
}))
vi.mock('./session-outcome-evidence', () => ({ verifySessionOutcomeCondition: vi.fn() }))
vi.mock('./session-outcome-git-deliverables', () => ({
  materializeSessionOutcomeGitDeliverables: vi.fn(async () => {})
}))
vi.mock('./session-outcome-verification', () => ({
  verifySessionOutcomeProgress: vi.fn(async (_runtime, chain) => ({
    set: chain.outcomeSet,
    reason: 'Waiting for the directing person to approve the exact packet.'
  }))
}))
beforeEach(() => vi.clearAllMocks())
function fixture() {
  const { workflow } = workflowProofFixture()
  let chain = {
    id: 'handoff',
    workspacePath: '/workspace',
    worktreeId: 'worktree',
    steps: [
      {
        id: 'handoff',
        kind: 'handoff',
        status: 'queued',
        handoff: { taskId: 'btk_root', recipients: [] }
      }
    ],
    outcomeSet: {
      schemaVersion: 1,
      revision: 1,
      updatedAt: 1,
      workflow,
      attempts: [],
      completedSteps: [],
      continuation: { taskId: 'btk_root' },
      outcomes: [
        {
          id: 'build',
          title: 'Merged result then Sal',
          finish: 'human-handoff',
          revision: 1,
          status: 'pending',
          dependsOn: [],
          stepIds: ['handoff'],
          actions: [],
          evidence: [],
          conditions: [
            { id: 'merge', kind: 'merge', target: 'Reviewed PR' },
            { id: 'human', kind: 'review', target: 'Sal', recipientId: 'emp_sal' }
          ]
        }
      ]
    }
  } as unknown as SessionChain
  const service = {
    runtime: {},
    save: (next: SessionChain) => {
      chain = next
      return chain
    }
  } as unknown as SessionOutcomeService
  return { service, get: () => chain }
}
it('delivers the real handoff only after merge proof and leaves human approval pending', async () => {
  const f = fixture()
  vi.mocked(verifySessionOutcomeCondition).mockResolvedValue({
    verified: false,
    reason: 'The reviewed PR has not merged.'
  })
  await advanceSessionOutcomeWorkflowEffects(f.service, f.get())
  expect(executeSessionOutcomeHandoff).not.toHaveBeenCalled()
  vi.mocked(verifySessionOutcomeCondition).mockResolvedValue({
    verified: true,
    receipt: 'actual_provider_merged_sha'
  })
  await advanceSessionOutcomeWorkflowEffects(f.service, f.get())
  expect(executeSessionOutcomeHandoff).toHaveBeenCalledOnce()
  expect(f.get().outcomeSet!.outcomes[0]).toMatchObject({
    status: 'blocked',
    blockedReason: 'Waiting for the directing person to approve the exact packet.'
  })
  await advanceSessionOutcomeWorkflowEffects(f.service, f.get())
  expect(executeSessionOutcomeHandoff).toHaveBeenCalledOnce()
})
it('holds a refused handoff instead of re-sending it on every tick', async () => {
  const f = fixture()
  vi.mocked(verifySessionOutcomeCondition).mockResolvedValue({ verified: true, receipt: 'merged' })
  const step = f.get().steps[0] as { handoff: { recipients: unknown[] } }
  step.handoff.recipients = [
    {
      employeeId: 'emp_sal',
      name: 'Sal',
      operationId: 'op',
      delivery: 'failed',
      error: 'not in roster'
    }
  ]
  await advanceSessionOutcomeWorkflowEffects(f.service, f.get())
  await advanceSessionOutcomeWorkflowEffects(f.service, f.get())
  expect(executeSessionOutcomeHandoff).not.toHaveBeenCalled()
  expect(materializeSessionOutcomeGitDeliverables).not.toHaveBeenCalled()
  expect(f.get().outcomeSet!.outcomes[0]).toMatchObject({
    status: 'blocked',
    blockedReason: 'The hub refused the handoff to Sal: not in roster'
  })
})
it('does not let a changed action borrow an older completed action identity to hand off', async () => {
  const f = fixture(),
    outcome = f.get().outcomeSet!.outcomes[0]!
  outcome.actions = [
    {
      id: 'repair',
      instruction: 'New authorized repair',
      conditionIds: ['merge'],
      authority: 'existing-user-authority',
      agent: 'codex'
    }
  ]
  f.get().outcomeSet!.attempts = [
    {
      id: 'prior',
      outcomeId: 'build',
      actionId: 'repair',
      actionKey: 'old_instruction',
      outcomeRevision: 1,
      state: 'completed',
      startedAt: 1,
      updatedAt: 1
    }
  ]
  vi.mocked(verifySessionOutcomeCondition).mockResolvedValue({ verified: true, receipt: 'merged' })
  await advanceSessionOutcomeWorkflowEffects(f.service, f.get())
  expect(executeSessionOutcomeHandoff).not.toHaveBeenCalled()
})
it('refuses delivery when canonical stage readback is unavailable even if old completion markers remain', async () => {
  const f = fixture()
  f.get().outcomeSet!.workflow!.error = 'Canonical verification is unavailable'
  f.get().steps.unshift({
    id: 'producer',
    agent: 'codex',
    model: 'gpt-5.6-terra',
    prompt: 'Actual current producer',
    status: 'launched'
  })
  f.get().outcomeSet!.outcomes[0]!.stepIds!.unshift('producer')
  f.get().outcomeSet!.completedSteps = ['producer']
  vi.mocked(verifySessionOutcomeCondition).mockResolvedValue({ verified: true, receipt: 'merged' })
  await advanceSessionOutcomeWorkflowEffects(f.service, f.get())
  expect(executeSessionOutcomeHandoff).not.toHaveBeenCalled()
})

it('runs same-outcome merge only after admitted agent steps, then gates its human handoff on merged proof', async () => {
  const f = fixture()
  const outcome = f.get().outcomeSet!.outcomes[0]!
  outcome.finish = 'merge'
  outcome.stepIds = ['producer', 'astra', 'sol', 'handoff']
  f.get().steps.unshift(
    ...['producer', 'astra', 'sol'].map((id) => ({
      id,
      agent: 'codex' as const,
      model: id === 'producer' ? 'gpt-5.6-terra' : id === 'astra' ? 'gpt-6-astra' : 'gpt-5.6-sol',
      prompt: 'Execute the real stage.',
      status: 'queued' as const
    }))
  )
  vi.mocked(verifySessionOutcomeCondition).mockResolvedValue({
    verified: false,
    reason: 'Awaiting merged readback'
  })
  await advanceSessionOutcomeWorkflowEffects(f.service, f.get())
  expect(publishSessionOutcomeMerge).not.toHaveBeenCalled()
  expect(executeSessionOutcomeHandoff).not.toHaveBeenCalled()
  f.get().outcomeSet!.completedSteps = ['producer', 'astra']
  await advanceSessionOutcomeWorkflowEffects(f.service, f.get())
  expect(publishSessionOutcomeMerge).not.toHaveBeenCalled()
  f.get().outcomeSet!.completedSteps!.push('sol')
  await advanceSessionOutcomeWorkflowEffects(f.service, f.get())
  expect(publishSessionOutcomeMerge).toHaveBeenCalledOnce()
  expect(executeSessionOutcomeHandoff).not.toHaveBeenCalled()
  vi.mocked(verifySessionOutcomeCondition).mockResolvedValue({
    verified: true,
    receipt: 'provider-confirmed-merge'
  })
  await advanceSessionOutcomeWorkflowEffects(f.service, f.get())
  expect(executeSessionOutcomeHandoff).toHaveBeenCalledOnce()
  expect(f.get().outcomeSet!.outcomes[0]!.status).not.toBe('satisfied')
})

it('does not let an obsolete retired audit error block a replacement handoff after current work is verified', async () => {
  const f = fixture()
  const prior = structuredClone(f.get().outcomeSet!.workflow!)
  prior.operationId = 'retired'
  prior.retired = true
  prior.error = 'Historical readback unavailable'
  f.get().outcomeSet!.workflowHistory = [prior]
  f.get().outcomeSet!.workflow!.stages[0]!.stepIds = ['replacement']
  f.get().steps.unshift({
    id: 'replacement',
    agent: 'codex',
    model: 'gpt-5.6-terra',
    prompt: 'Current work',
    status: 'launched'
  })
  f.get().outcomeSet!.outcomes[0]!.stepIds!.unshift('replacement')
  f.get().outcomeSet!.completedSteps = ['replacement']
  vi.mocked(verifySessionOutcomeCondition).mockResolvedValue({
    verified: true,
    receipt: 'Actual merged result'
  })
  await advanceSessionOutcomeWorkflowEffects(f.service, f.get())
  expect(executeSessionOutcomeHandoff).toHaveBeenCalledOnce()
})

it('materializes a closed accepted candidate before an unsatisfied dependency delays handoff', async () => {
  const f = fixture()
  const { jobs } = workflowProofFixture()
  const workflow = f.get().outcomeSet!.workflow!
  workflow.closedStages = closedSessionOutcomeStages(workflow, jobs).map((stage) => ({
    key: stage.key,
    round: stage.round,
    reviewJobIds: stage.reviews.map((review) => review.jobId),
    verificationReportId: stage.verificationReportId,
    evidenceId: stage.evidenceId
  }))
  const outcome = f.get().outcomeSet!.outcomes[0]!
  outcome.stepIds = ['producer', 'astra', 'sol', 'handoff']
  outcome.dependsOn = ['prerequisite']
  f.get().steps.unshift(
    {
      id: 'producer',
      kind: 'agent',
      agent: 'codex',
      model: 'gpt-5.6-terra',
      prompt: 'produce',
      status: 'queued'
    },
    {
      id: 'astra',
      kind: 'agent',
      agent: 'codex',
      model: 'gpt-6-astra',
      prompt: 'review',
      status: 'queued'
    },
    {
      id: 'sol',
      kind: 'agent',
      agent: 'codex',
      model: 'gpt-5.6-sol',
      prompt: 'review',
      status: 'queued'
    }
  )
  f.get().outcomeSet!.completedSteps = ['producer', 'astra', 'sol']
  f.get().outcomeSet!.outcomes.push({
    ...structuredClone(outcome),
    id: 'prerequisite',
    title: 'Prerequisite',
    stepIds: [],
    dependsOn: [],
    status: 'pending'
  })

  await advanceSessionOutcomeWorkflowEffects(f.service, f.get())

  expect(materializeSessionOutcomeGitDeliverables).toHaveBeenCalledOnce()
  expect(executeSessionOutcomeHandoff).not.toHaveBeenCalled()
})
