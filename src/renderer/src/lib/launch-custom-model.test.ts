import { beforeEach, expect, it, vi } from 'vitest'
import { launchCustomModel } from './launch-custom-model'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  web: vi.fn(),
  route: vi.fn(),
  current: vi.fn(),
  activate: vi.fn(),
  focus: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.call }))
vi.mock('@/runtime/agent-session-create-operation', () => ({
  createAgentSessionCreateOperation: () => ({
    run: (invoke: (id: string) => unknown) => invoke('same-operation')
  })
}))
vi.mock('@/runtime/web-runtime-terminal-create-operation', () => ({
  createWebRuntimeSessionTerminalResult: mocks.web
}))
vi.mock('./worktree-operation-route', () => ({ resolveWorktreeOperationRoute: mocks.route }))
vi.mock('./worktree-operation-generation', () => ({
  captureWorktreeOperationGenerationGuard: () => ({ assertCurrent: mocks.current })
}))
vi.mock('./worktree-activation', () => ({ activateAndRevealWorkspace: mocks.activate }))
vi.mock('./activate-tab-and-focus-pane', () => ({ activateTabAndFocusPane: mocks.focus }))

const input = {
  worktreeId: 'folder:owned',
  modelId: 'vendor/exact:free',
  viewMode: 'terminal' as const
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.route.mockReturnValue({ executionHostId: 'local', runtimeEnvironmentId: null })
  mocks.call.mockResolvedValue({ terminal: { tabId: 'created' } })
})

it('uses the existing host-authoritative session API for folder launches with only the exact selector', async () => {
  expect(await launchCustomModel(input)).toBe('created')
  expect(mocks.call).toHaveBeenCalledWith({ kind: 'local' }, 'terminal.createAgentSession', {
    clientOperationId: 'same-operation',
    worktree: 'id:folder:owned',
    agent: 'omp',
    launchPreferences: { model: 'openrouter/vendor/exact:free' },
    viewMode: 'terminal',
    presentation: 'focused'
  })
  expect(mocks.current).toHaveBeenCalledOnce()
  expect(mocks.focus).toHaveBeenCalledWith('created', null)
})

it('keeps paired launches in the existing capability-gated host creation path', async () => {
  mocks.route.mockReturnValue({ executionHostId: 'runtime:owner', runtimeEnvironmentId: 'owner' })
  mocks.web.mockResolvedValue({ outcome: { status: 'created' }, hostTabId: 'remote-created' })
  await launchCustomModel(input)
  expect(mocks.web).toHaveBeenCalledWith({
    worktreeId: 'folder:owned',
    environmentId: 'owner',
    agent: 'omp',
    agentSessionKind: 'fresh',
    launchPreferences: { model: 'openrouter/vendor/exact:free' },
    viewMode: 'terminal',
    activate: true
  })
  expect(mocks.call).not.toHaveBeenCalled()
})

it('never retries a refused exact route through a raw or default launcher', async () => {
  mocks.call.mockRejectedValue(new Error('OpenRouter authentication unavailable'))
  await expect(launchCustomModel(input)).rejects.toThrow('OpenRouter authentication unavailable')
  expect(mocks.call).toHaveBeenCalledOnce()
  expect(mocks.web).not.toHaveBeenCalled()
  expect(mocks.activate).not.toHaveBeenCalled()
})

it('does not interpret a missing owner as permission to launch locally', async () => {
  mocks.route.mockReturnValue(null)
  await expect(launchCustomModel(input)).rejects.toThrow('execution host')
  expect(mocks.call).not.toHaveBeenCalled()
  expect(mocks.web).not.toHaveBeenCalled()
})
