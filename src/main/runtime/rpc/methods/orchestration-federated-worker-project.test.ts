import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  started: vi.fn(async (_args: unknown) => ({ state: 'ready', dispatchId: 'ctx_1' })),
  inheritOn: vi.fn()
}))
vi.mock('./orchestration-federated-worker-start', () => ({
  startFederatedWorker: mocks.started
}))

import { startFederatedWorkerInProject } from './orchestration-federated-worker-project'

const args = () =>
  ({
    params: { task: 'task_1', from: 'term_coord', on: 'studio' },
    runtime: {
      resolveOrchestrationWorkerServer: () => ({ environmentId: 'env-1', name: 'Studio' })
    },
    db: {},
    runId: 'run_1',
    task: { id: 'task_1', spec: 'Fix the login bug', status: 'ready' },
    project: { inherit: vi.fn(), inheritOn: mocks.inheritOn }
  }) as never

describe('startFederatedWorkerInProject', () => {
  it("puts that computer's brief ahead of the task text and names the project on the receipt", async () => {
    const project = { folderId: 'project-1', name: 'Ads', notOnHost: [] }
    mocks.inheritOn.mockResolvedValueOnce({ brief: 'Project: Ads', receipt: { project } })
    await expect(startFederatedWorkerInProject(args())).resolves.toEqual({
      state: 'ready',
      dispatchId: 'ctx_1',
      project
    })
    expect(mocks.inheritOn).toHaveBeenCalledWith({ hostId: 'runtime:env-1', name: 'Studio' })
    expect(mocks.started.mock.calls.at(-1)?.[0]).toMatchObject({
      task: { id: 'task_1', spec: 'Project: Ads\n\nFix the login bug' }
    })
  })

  it('sends the task text unchanged when the worker joins no project', async () => {
    mocks.inheritOn.mockResolvedValueOnce({ receipt: {} })
    await expect(startFederatedWorkerInProject(args())).resolves.toEqual({
      state: 'ready',
      dispatchId: 'ctx_1'
    })
    expect(mocks.started.mock.calls.at(-1)?.[0]).toMatchObject({
      task: { spec: 'Fix the login bug' }
    })
  })

  it('keeps the brief and dispatch on the same computer when a friendly selector changes', async () => {
    const supplied = args() as Parameters<typeof startFederatedWorkerInProject>[0]
    let studioId = 'env-1'
    supplied.runtime.resolveOrchestrationWorkerServer = (selector) => ({
      environmentId: selector === 'studio' ? studioId : selector,
      name: 'Studio',
      peerFingerprint: 'peer'
    })
    mocks.inheritOn.mockImplementationOnce(async () => {
      studioId = 'env-2'
      return { brief: 'Source: /env-1/repo/brief.md', receipt: {} }
    })
    mocks.started.mockImplementationOnce(async (input) => {
      const delegated = input as typeof supplied
      const target = supplied.runtime.resolveOrchestrationWorkerServer(delegated.params.on!)
      expect(target.environmentId).toBe('env-1')
      expect(delegated.task.spec).toContain('/env-1/repo/brief.md')
      return { state: 'ready', dispatchId: 'ctx_1' }
    })
    await startFederatedWorkerInProject(supplied)
    expect(supplied.params.on).toBe('studio')
  })

  it("starts on the project's first computer when worker-start names none", async () => {
    const supplied = args() as Parameters<typeof startFederatedWorkerInProject>[0]
    supplied.params.on = undefined
    supplied.project.on = 'env-9'
    supplied.runtime.resolveOrchestrationWorkerServer = (selector) => ({
      environmentId: selector,
      name: 'Mac Studio',
      peerFingerprint: 'peer'
    })
    mocks.inheritOn.mockResolvedValueOnce({ receipt: {} })
    await startFederatedWorkerInProject(supplied)
    expect(mocks.inheritOn).toHaveBeenLastCalledWith({
      hostId: 'runtime:env-9',
      name: 'Mac Studio'
    })
    expect(mocks.started.mock.calls.at(-1)?.[0]).toMatchObject({ params: { on: 'env-9' } })
  })
})
