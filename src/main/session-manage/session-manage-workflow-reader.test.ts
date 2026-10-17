import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import {
  buildReviewPipelineNotFound,
  LOCAL_WORKFLOW_NOT_FOUND
} from '../../shared/session-workflow-anchor'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { sidebarRow } from './session-manage-test-fixtures'

const controller = vi.hoisted(() => ({
  status: vi.fn(),
  show: vi.fn(),
  evolve: vi.fn()
}))
vi.mock('../runtime/workflow-script/local-workflow-runtime-host', () => ({
  getLocalWorkflowHost: async () => ({ status: controller.status })
}))
vi.mock('../runtime/build-review/build-review-service-registry', () => ({
  getBuildReviewService: () => ({ show: controller.show })
}))
vi.mock('../runtime/evolve/evolve-service-registry', () => ({
  getEvolveService: () => ({ show: controller.evolve })
}))

const { readRuntimeWorkflowRun, SESSION_WORKFLOW_READ_TIMEOUT_MS } =
  await import('./session-manage-workflow-reader')

const runtime = {} as OrcaRuntimeService
const ref = { controller: 'local' as const, runId: 'execution-1' }

function row(preset: string): SessionManageSidebarRow {
  return sidebarRow({
    paneKey: null,
    tabId: 'tab-1',
    worktreeId: 'repo::/w',
    workflow: { controller: 'local', preset, runId: 'execution-1', status: 'unknown' }
  })
}

beforeEach(() => {
  vi.useRealTimers()
  controller.status.mockReset()
  controller.show.mockReset()
  controller.evolve.mockReset()
})

describe('reading a workflow run from its controller', () => {
  it('reads a Council run by its conversation and execution, read-only', async () => {
    controller.status.mockResolvedValue({ state: 'completed' })
    await expect(readRuntimeWorkflowRun(runtime)(row('council'), ref)).resolves.toEqual({
      status: 'done'
    })
    expect(controller.status).toHaveBeenCalledWith({
      worktree: 'id:repo::/w',
      conversationId: 'tab-1',
      executionId: 'execution-1'
    })
  })

  it('tells the controller’s not-found answer from a failed read', async () => {
    controller.status.mockRejectedValueOnce(new Error(LOCAL_WORKFLOW_NOT_FOUND))
    await expect(readRuntimeWorkflowRun(runtime)(row('council'), ref)).resolves.toEqual({
      status: 'missing'
    })
    controller.status.mockRejectedValueOnce(new Error('Workflow belongs to another conversation.'))
    await expect(readRuntimeWorkflowRun(runtime)(row('council'), ref)).resolves.toMatchObject({
      status: 'unavailable'
    })
    controller.show.mockImplementation(() => {
      throw new Error(buildReviewPipelineNotFound('execution-1'))
    })
    await expect(readRuntimeWorkflowRun(runtime)(row('build-review'), ref)).resolves.toEqual({
      status: 'missing'
    })
  })

  it('reads a controller that does not answer in time as status unavailable', async () => {
    vi.useFakeTimers()
    controller.status.mockReturnValue(new Promise(() => {}))
    const reading = readRuntimeWorkflowRun(runtime)(row('council'), ref)
    await vi.advanceTimersByTimeAsync(SESSION_WORKFLOW_READ_TIMEOUT_MS)
    await expect(reading).resolves.toMatchObject({ status: 'unavailable' })
  })
})
