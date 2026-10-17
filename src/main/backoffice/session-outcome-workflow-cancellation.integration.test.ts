import { rm } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { createConsoleLocalExecutionFixture } from '../console-workflows/console-local-execution-test-fixture'
import { createSessionOutcomeCancellationPort } from './session-outcome-workflow-cancellation'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import { requestConsoleWorkflow } from './console-workflow-transport'
import { getConsoleLocalExecution } from '../console-workflows/console-local-execution-registration'
import { workflowProofFixture } from '../runtime/session-outcome-workflow-proof-fixture'
import type { ConsoleWorkflowJob } from '../../shared/console-workflow-types'
vi.mock('./console-workflow-person', () => ({ captureConsoleWorkflowPerson: vi.fn() }))
vi.mock('./console-workflow-transport', () => ({ requestConsoleWorkflow: vi.fn() }))
vi.mock('../console-workflows/console-local-execution-registration', () => ({
  getConsoleLocalExecution: vi.fn()
}))
const fixtures: Awaited<ReturnType<typeof createConsoleLocalExecutionFixture>>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.service.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    f.db.close()
    await rm(f.directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})
async function fixture(running: boolean) {
  const f = await createConsoleLocalExecutionFixture({ workspaceKind: 'folder' })
  fixtures.push(f)
  const { workflow } = workflowProofFixture()
  workflow.preview.workflow_id = f.job.workflowId
  workflow.preview.digest = f.job.digest
  workflow.preview.graph.dispatch_id = f.job.workflowId
  workflow.preview.graph.digest = f.job.digest
  workflow.canonicalSeal!.workflow_id = f.job.workflowId
  const job = {
    id: f.job.id,
    task_id: f.job.taskId,
    provider: f.job.provider,
    model: f.job.model,
    attempt: running ? 1 : null,
    lease_generation: running ? 3 : null,
    status: running ? 'running' : 'queued',
    policy: {
      workflow: {
        key: 'build',
        digest: f.job.digest,
        hub_projection: { ...workflow.canonicalSeal, satisfied: false }
      }
    }
  } as unknown as ConsoleWorkflowJob
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: { principal: 'a'.repeat(64), isCurrent: () => true }
  } as never)
  vi.mocked(getConsoleLocalExecution).mockReturnValue(f.service)
  const request = vi.mocked(requestConsoleWorkflow).mockImplementation(async (path, method) => {
    if (method === 'POST') {
      expect(path).toBe(`/api/gtd/workflow-jobs/${job.id}/cancel`)
      job.status = 'cancelled'
      return { ok: true, data: { ok: true, job: { id: job.id, status: 'cancelled' } } } as never
    }
    expect(path).toBe(`/api/gtd/workflow-graphs/${f.job.workflowId}`)
    return { ok: true, data: { ok: true, workflow_id: f.job.workflowId, jobs: [job] } } as never
  })
  if (running) {
    const started = await f.service.start({
      jobId: f.job.id,
      workflowId: f.job.workflowId,
      approvedDigest: f.job.digest,
      worktree: 'id:source'
    })
    expect(started.ok).toBe(true)
    f.service.dispose()
  }
  return {
    ...f,
    job,
    workflow,
    request,
    port: createSessionOutcomeCancellationPort(f.runtime, [workflow], 'a'.repeat(64))
  }
}
it('uses signed queued cancellation/readback and proves zero attempts without creating a worker', async () => {
  const f = await fixture(false)
  const cancel = vi.spyOn(f.service, 'cancel')
  expect(await f.port.readJob(f.job.id)).toMatchObject({ state: 'queued', terminalStopped: true })
  await f.port.cancelQueued(f.job.id)
  expect(await f.port.readJob(f.job.id)).toMatchObject({
    state: 'cancelled',
    serverCancellationAcknowledged: true,
    terminalStopped: true
  })
  expect(cancel).not.toHaveBeenCalled()
  expect(f.runtime.createTerminal).not.toHaveBeenCalled()
})
it('stops an actual bound Dispatch after a queued-cancel race and requires physical process exit', async () => {
  const f = await fixture(true)
  const before = await f.port.readJob(f.job.id)
  expect(before).toMatchObject({
    state: 'running',
    terminalStopped: false,
    attempt: 1,
    leaseGeneration: 3
  })
  vi.spyOn(f.runtime, 'closeTerminal').mockImplementation(async () => {
    f.exitGate(null, 15)
    return { ptyKilled: true } as never
  })
  await f.port.cancelQueued(f.job.id)
  const after = await f.port.readJob(f.job.id)
  expect(after).toMatchObject({
    state: 'cancelled',
    terminalStopped: true,
    dispatchId: before.dispatchId,
    runId: before.runId
  })
  expect(f.journal.record).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      status: 'cancelled',
      terminal_proof: expect.objectContaining({ process_exited: true })
    })
  )
})
