import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type {
  AdoptProvisionedRootArgs,
  CreateWorktreeArgs,
  CreateWorktreeResult
} from '../../../../shared/worktree/create-types'
import type { AutomationWorkspaceProvenanceRequest } from '../../../../shared/worktree/types'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import { registerWorktreeCreateHandlers } from './register-worktree-create-handlers'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  bind: vi.fn(),
  resolve: vi.fn(),
  release: vi.fn(),
  finish: vi.fn(),
  local: vi.fn(),
  remote: vi.fn(),
  folder: vi.fn(),
  adopt: vi.fn(),
  notify: vi.fn(),
  track: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: mocks.handle },
  app: { getPath: () => '/profile' }
}))
vi.mock('../../../observability/instrumentation', () => ({
  withWorktreeSpan: (_attributes: unknown, work: () => Promise<unknown>) => work()
}))
vi.mock('../../../automations/automation-output-binding', () => ({
  bindAutomationOutputWorkspace: mocks.bind
}))
vi.mock('../../../automations/workspace-provenance', () => ({
  resolveAutomationWorkspaceProvenance: mocks.resolve,
  releaseAutomationWorkspaceProvenanceRequest: mocks.release,
  finishAutomationWorkspaceProvenanceRequest: mocks.finish
}))
vi.mock('../../worktree-remote', () => ({
  createLocalWorktree: mocks.local,
  createRemoteWorktree: mocks.remote,
  notifyWorktreesChanged: mocks.notify
}))
vi.mock('./folder-workspace-creation', () => ({ createFolderWorkspace: mocks.folder }))
vi.mock('../../../provisioned-root-ssh-adoption', () => ({
  adoptProvisionedRootSshCheckout: mocks.adopt
}))
vi.mock('../../../telemetry/client', () => ({ track: mocks.track }))
vi.mock('../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
vi.mock('../../workspace-create-error-classifier', () => ({
  classifyWorkspaceCreateError: () => 'unknown'
}))

const request: AutomationWorkspaceProvenanceRequest = {
  automationId: 'routine-1',
  automationRunId: 'run-1',
  dispatchToken: 'dispatch-token',
  createRequestId: 'create-request'
}

const result: CreateWorktreeResult = {
  worktree: {
    id: 'repo-1::/workspace/actual-created-name',
    repoId: 'repo-1',
    path: '/workspace/actual-created-name',
    branch: 'actual-created-name',
    head: 'created-head',
    displayName: 'Created workspace',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    isBare: false,
    isMainWorktree: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

type Handler = (
  event: null,
  args: CreateWorktreeArgs | AdoptProvisionedRootArgs
) => Promise<CreateWorktreeResult>

const routes = [
  { name: 'local git creation', channel: 'worktrees:create', helper: 'local' },
  { name: 'SSH creation', channel: 'worktrees:create', helper: 'remote' },
  { name: 'folder creation', channel: 'worktrees:create', helper: 'folder' },
  {
    name: 'provisioned-root adoption',
    channel: 'worktrees:adoptProvisionedRoot',
    helper: 'adopt'
  }
] as const

function fixture(route: (typeof routes)[number]) {
  const repo: Repo = {
    id: 'repo-1',
    path: '/workspace/repo',
    displayName: 'Repository',
    badgeColor: '#000000',
    addedAt: 0,
    kind: route.helper === 'folder' ? 'folder' : 'git',
    connectionId: route.helper === 'remote' || route.helper === 'adopt' ? 'host-1' : null
  }
  const store = { getRepo: vi.fn(() => repo), getRepos: vi.fn(() => [repo]) }
  const onWorktreeLifecycle = vi.fn()
  const context = {
    store,
    mainWindow: {},
    runtime: {},
    options: { onWorktreeLifecycle }
  } as unknown as WorktreeIpcContext
  const args: AdoptProvisionedRootArgs = {
    repoId: repo.id,
    name: 'requested-name',
    automationProvenanceRequest: request,
    runtimeId: 'runtime-1',
    executionHostId: 'ssh:host-1',
    expectedPath: '/workspace/provisioned-root'
  }
  registerWorktreeCreateHandlers(context)
  const handler = mocks.handle.mock.calls.find(([channel]) => channel === route.channel)?.[1]
  if (!handler) {
    throw new Error(`Missing handler: ${route.channel}`)
  }
  return {
    store,
    args,
    onWorktreeLifecycle,
    invoke: (input: CreateWorktreeArgs = args) => (handler as Handler)(null, input)
  }
}

describe.each(routes)('automation output workspace binding: $name', (route) => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.local.mockResolvedValue(result)
    mocks.remote.mockResolvedValue(result)
    mocks.folder.mockReturnValue(result)
    mocks.adopt.mockResolvedValue(result)
  })

  it('binds the actual successful workspace with the same Store before finishing the token', async () => {
    const { store, invoke, onWorktreeLifecycle } = fixture(route)

    await expect(invoke()).resolves.toBe(result)

    expect(mocks[route.helper]).toHaveBeenCalledOnce()
    expect(mocks.bind).toHaveBeenCalledExactlyOnceWith(store, request, result.worktree.id)
    expect(mocks.bind.mock.calls[0]?.[0]).toBe(store)
    expect(mocks.bind.mock.calls[0]?.[1]).toBe(request)
    expect(mocks.finish).toHaveBeenCalledExactlyOnceWith(request)
    expect(mocks.bind.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.finish.mock.invocationCallOrder[0]!
    )
    expect(mocks.release).not.toHaveBeenCalled()
    expect(onWorktreeLifecycle).toHaveBeenCalledExactlyOnceWith({
      kind: 'created',
      worktreeId: result.worktree.id,
      path: result.worktree.path,
      branch: result.worktree.branch
    })
  })

  it('releases a failed create without binding or finishing its token', async () => {
    const error = new Error('Workspace creation failed')
    if (route.helper === 'folder') {
      mocks.folder.mockImplementation(() => {
        throw error
      })
    } else {
      mocks[route.helper].mockRejectedValue(error)
    }
    const { invoke, onWorktreeLifecycle } = fixture(route)

    await expect(invoke()).rejects.toBe(error)

    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(request)
    expect(mocks.bind).not.toHaveBeenCalled()
    expect(mocks.finish).not.toHaveBeenCalled()
    expect(onWorktreeLifecycle).not.toHaveBeenCalled()
    expect(mocks.track).toHaveBeenCalledWith(
      'workspace_create_failed',
      expect.objectContaining({ error_class: 'unknown' })
    )
  })

  it('preserves ordinary creation when no automation request is present', async () => {
    const { store, args, invoke, onWorktreeLifecycle } = fixture(route)
    const { automationProvenanceRequest: _request, ...ordinaryArgs } = args

    await expect(invoke(ordinaryArgs)).resolves.toBe(result)

    expect(mocks.bind).toHaveBeenCalledExactlyOnceWith(store, undefined, result.worktree.id)
    expect(mocks.finish).toHaveBeenCalledExactlyOnceWith(undefined)
    expect(mocks.release).not.toHaveBeenCalled()
    expect(onWorktreeLifecycle).toHaveBeenCalledOnce()
  })
})
