import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  discoverCommitMessageModels: vi.fn()
}))

vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc,
  getActiveRuntimeTarget: (settings: { activeRuntimeEnvironmentId?: string | null }) =>
    settings.activeRuntimeEnvironmentId
      ? { kind: 'environment', environmentId: settings.activeRuntimeEnvironmentId }
      : { kind: 'local' }
}))

import { discoverRuntimeCommitMessageModels } from './runtime-git-generation-client'

beforeEach(() => {
  mocks.callRuntimeRpc.mockReset().mockResolvedValue({ success: false, error: '' })
  mocks.discoverCommitMessageModels.mockReset().mockResolvedValue({ success: false, error: '' })
  vi.stubGlobal('window', {
    api: { git: { discoverCommitMessageModels: mocks.discoverCommitMessageModels } }
  })
})

describe('a launch’s explicit model refresh', () => {
  it('reaches this host and an active runtime, and is left out otherwise', async () => {
    const local = {
      settings: { activeRuntimeEnvironmentId: null },
      worktreeId: null,
      worktreePath: '/repo'
    }
    await discoverRuntimeCommitMessageModels(local, 'codex', { force: true })
    await discoverRuntimeCommitMessageModels(local, 'codex')
    expect(mocks.discoverCommitMessageModels.mock.calls).toStrictEqual([
      [{ agentId: 'codex', worktreePath: '/repo', connectionId: undefined, force: true }],
      [{ agentId: 'codex', worktreePath: '/repo', connectionId: undefined }]
    ])

    const remote = {
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      worktreeId: 'wt-1',
      worktreePath: '/repo'
    }
    await discoverRuntimeCommitMessageModels(remote, 'codex', { force: true })
    await discoverRuntimeCommitMessageModels(remote, 'codex')
    expect(mocks.callRuntimeRpc.mock.calls.map((call) => call[2])).toStrictEqual([
      { worktree: 'id:wt-1', agentId: 'codex', force: true },
      { worktree: 'id:wt-1', agentId: 'codex' }
    ])
  })
})
