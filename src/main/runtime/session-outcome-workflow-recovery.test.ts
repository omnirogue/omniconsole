import { beforeEach, expect, it, vi } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeService } from './session-outcome-service'
import { workflowProofFixture } from './session-outcome-workflow-proof-fixture'
import { advanceSessionOutcomeWorkflow } from './session-outcome-workflow-tick'
import { installSessionOutcomeWorkflowPort } from './session-outcome-workflow-port'
import { assertSessionOutcomePlanningSource } from './session-outcome-workflow-source'
import { advanceSessionOutcomeWorkflowEffects } from './session-outcome-workflow-effects'
import { reconcileOutcomeAmendment } from '../backoffice/outcome-amendment-reconciliation'
vi.mock('./session-outcome-workflow-source', () => ({
  assertSessionOutcomePlanningSource: vi.fn()
}))
vi.mock('./session-outcome-workflow-effects', () => ({
  advanceSessionOutcomeWorkflowEffects: vi.fn()
}))
vi.mock('../backoffice/outcome-amendment-reconciliation', () => ({
  reconcileOutcomeAmendment: vi.fn()
}))
beforeEach(() => vi.resetAllMocks())
function fixture() {
  const { workflow, jobs } = workflowProofFixture()
  let chain = {
    id: 'recovery',
    steps: [],
    currentIndex: 0,
    outcomeSet: {
      workflow,
      revision: 1,
      completedSteps: [],
      attempts: [],
      continuation: { sourceReady: true, principal: 'person', taskId: 'btk_root' },
      outcomes: [{ id: 'build', stepIds: [], actions: [], evidence: [], status: 'pending' }]
    }
  } as unknown as SessionChain
  const service = {
    runtime: {},
    get: () => chain,
    save: (next: SessionChain) => {
      chain = next
      return next
    }
  } as unknown as SessionOutcomeService
  const port = {
    observe: vi.fn(async () => ({
      ok: true,
      data: { workflow_id: workflow.preview.workflow_id, jobs }
    })),
    list: vi.fn(async () => ({ ok: true, data: [] })),
    receipt: vi.fn(async () => null),
    admit: vi.fn(),
    start: vi.fn(),
    cancellation: vi.fn()
  }
  installSessionOutcomeWorkflowPort(port as never)
  return { get: () => chain, service, workflow, jobs, port }
}
it('allows readback and effects after the coordinator changes when no new job is starting', async () => {
  const f = fixture()
  vi.mocked(assertSessionOutcomePlanningSource).mockImplementation(() => {
    throw new Error('Coordinator changed')
  })
  await advanceSessionOutcomeWorkflow(f.service, f.get())
  expect(f.port.observe).toHaveBeenCalledOnce()
  expect(advanceSessionOutcomeWorkflowEffects).toHaveBeenCalledOnce()
  expect(assertSessionOutcomePlanningSource).not.toHaveBeenCalled()
  expect(f.get().outcomeSet!.workflow!.error).toBeUndefined()
})
it('still checks the pristine coordinator immediately before a new activation', async () => {
  const f = fixture()
  f.jobs[0]!.status = 'queued'
  f.jobs[0]!.workflow_state = 'ready'
  f.jobs[0]!.policy.workflow.placement = 'local'
  vi.mocked(assertSessionOutcomePlanningSource).mockImplementation(() => {
    throw new Error('Coordinator changed')
  })
  await advanceSessionOutcomeWorkflow(f.service, f.get())
  expect(f.port.observe).toHaveBeenCalledOnce()
  expect(assertSessionOutcomePlanningSource).toHaveBeenCalledOnce()
  expect(f.port.start).not.toHaveBeenCalled()
  expect(f.get().outcomeSet!.workflow!.error).toBe('Coordinator changed')
})
it('does not re-admit an obsolete retired generation left in admitting', async () => {
  const f = fixture()
  f.workflow.retired = true
  f.workflow.phase = 'admitting'
  await advanceSessionOutcomeWorkflow(f.service, f.get())
  expect(f.port.admit).not.toHaveBeenCalled()
  expect(f.port.observe).not.toHaveBeenCalled()
  expect(f.get().outcomeSet!.workflow!.phase).toBe('admitting')
})
it('surfaces a blocked amendment job reason on the affected pending outcome', async () => {
  const f = fixture()
  const amendment = {
    id: 'amendment',
    state: 'blocked',
    principal: 'person',
    sourceOperationIds: [f.workflow.operationId],
    jobs: [{ jobId: 'job_blocked', state: 'blocked', error: 'Claim cannot be reconciled.' }]
  }
  f.get().outcomeSet!.amendment = amendment as never
  vi.mocked(reconcileOutcomeAmendment).mockResolvedValue(amendment as never)
  await advanceSessionOutcomeWorkflow(f.service, f.get())
  expect(f.get().outcomeSet!.outcomes[0]).toMatchObject({
    status: 'blocked',
    blockedReason: 'Claim cannot be reconciled.'
  })
  expect(f.port.observe).not.toHaveBeenCalled()
  expect(advanceSessionOutcomeWorkflowEffects).not.toHaveBeenCalled()
})

function ready(f: ReturnType<typeof fixture>) {
  f.jobs[0]!.status = 'queued'
  f.jobs[0]!.workflow_state = 'ready'
  f.jobs[0]!.policy.workflow.placement = 'local'
}
function started(f: ReturnType<typeof fixture>) {
  return {
    jobId: f.jobs[0]!.id,
    workflowId: f.workflow.preview.workflow_id,
    dispatchId: 'ctx_actual',
    runId: 'run_actual',
    state: 'running'
  }
}
it('retries a proven pre-claim refusal and exposes its reason until recovery', async () => {
  const f = fixture()
  ready(f)
  f.port.start
    .mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'backoffice_unavailable',
        message: 'Temporary read failure',
        launchDisposition: 'not-started'
      }
    })
    .mockResolvedValueOnce({ ok: true, data: started(f) })
  await advanceSessionOutcomeWorkflow(f.service, f.get())
  expect(f.get().outcomeSet!.workflow!.error).toBe('Temporary read failure')
  await advanceSessionOutcomeWorkflow(f.service, f.get())
  expect(f.port.start).toHaveBeenCalledTimes(2)
  expect(f.get().outcomeSet!.workflow!.activations).toHaveLength(1)
  expect(f.get().outcomeSet!.workflow!.activations[0]).toMatchObject({
    state: 'started',
    dispatchId: 'ctx_actual'
  })
  expect(f.get().outcomeSet!.workflow!.error).toBeUndefined()
})
it('re-enters the fenced local start for a persisted requested claim with no local Dispatch', async () => {
  const f = fixture()
  ready(f)
  f.jobs[0]!.status = 'running'
  f.jobs[0]!.workflow_state = 'running'
  f.workflow.activations = [{ jobId: f.jobs[0]!.id, state: 'requested' }]
  f.port.start.mockResolvedValue({ ok: true, data: started(f) })
  await advanceSessionOutcomeWorkflow(f.service, f.get())
  expect(f.port.start).toHaveBeenCalledWith(
    f.service.runtime,
    expect.objectContaining({
      jobId: f.jobs[0]!.id,
      workflowId: f.workflow.preview.workflow_id,
      approvedDigest: f.workflow.preview.digest
    })
  )
  expect(f.get().outcomeSet!.workflow!.activations).toHaveLength(1)
})
it('recovers an existing local Dispatch before considering any start retry', async () => {
  const f = fixture()
  ready(f)
  f.workflow.activations = [{ jobId: f.jobs[0]!.id, state: 'requested' }]
  f.port.list.mockResolvedValue({ ok: true, data: [started(f)] } as never)
  await advanceSessionOutcomeWorkflow(f.service, f.get())
  expect(f.port.start).not.toHaveBeenCalled()
  expect(f.get().outcomeSet!.workflow!.activations[0]).toMatchObject({
    state: 'started',
    dispatchId: 'ctx_actual'
  })
})
it('keeps an ambiguous activation visible without treating it as a safe retry', async () => {
  const f = fixture()
  ready(f)
  f.port.start.mockResolvedValue({
    ok: false,
    error: { code: 'unknown', message: 'Claim result unknown' }
  })
  await advanceSessionOutcomeWorkflow(f.service, f.get())
  await advanceSessionOutcomeWorkflow(f.service, f.get())
  expect(f.port.start).toHaveBeenCalledOnce()
  expect(f.get().outcomeSet!.workflow!.error).toBe('Claim result unknown')
})
