import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listRegisteredSshTargets } from '../ssh/ssh-target-registry'
import { prepareSessionPrepRemoteAccountSelection } from '../session-prep/session-prep-remote-account'
import { prepareAgentSessionSshAccount } from './agent-session-ssh-account'

vi.mock('../ssh/ssh-target-registry', () => ({ listRegisteredSshTargets: vi.fn() }))
vi.mock('../session-prep/session-prep-remote-account', () => ({
  prepareSessionPrepRemoteAccountSelection: vi.fn()
}))

function relayReply(expiresAt = performance.now() + 60000) {
  return {
    env: { CODEX_HOME: '/remote/profile' },
    expiresAt,
    account: {
      provider: 'codex' as const,
      pinConfigDir: true,
      configRoot: '/remote/profile',
      readingAt: 1_800_000_000_000,
      ageAtReplyMs: 2_000,
      processingMs: 500,
      remainingPercent: 64
    },
    readingAgeMs: 2_500
  }
}

function fixture() {
  const target = {
    id: 'worker',
    generation: 1,
    label: 'Mac',
    host: 'worker.example',
    port: 22,
    username: 'sal'
  }
  vi.mocked(listRegisteredSshTargets).mockReturnValue([target] as never)
  vi.mocked(prepareSessionPrepRemoteAccountSelection).mockResolvedValue(relayReply())
  const workspace = {
    id: 'repo::/work',
    path: '/work',
    connectionId: 'worker' as string | null,
    repo: { id: 'repo', path: '/repo', executionHostId: 'ssh:worker' },
    folderWorkspace: null
  }
  const input = {
    request: {
      clientOperationId: 'unused',
      worktree: 'id:repo::/work',
      agent: 'codex' as const,
      viewMode: 'terminal' as const,
      launchPreferences: { model: 'requested', effort: 'high' },
      sshAccountSelection: {
        policy: 'best-verified' as const,
        expectedHostId: 'ssh:worker',
        expectedRuntimeId: '11111111-1111-4111-8111-111111111111'
      }
    },
    workspace,
    currentWorkspace: vi.fn(() => workspace),
    signal: new AbortController().signal
  }
  return { target, workspace, input }
}

describe('SSH launch account fence', () => {
  beforeEach(() => vi.clearAllMocks())

  it('selects on the execution host with the requested model and supplies a pre-spawn fence', async () => {
    const { input } = fixture()
    const prepared = await prepareAgentSessionSshAccount(input)
    expect(prepareSessionPrepRemoteAccountSelection).toHaveBeenCalledWith(
      'worker',
      'codex',
      'requested'
    )
    expect(prepared?.env).toEqual({ CODEX_HOME: '/remote/profile' })
    expect(() => prepared?.assertCurrent()).not.toThrow()
  })

  it('returns a receipt from the relay reply', async () => {
    const { input } = fixture()
    const prepared = await prepareAgentSessionSshAccount(input)
    expect(prepared?.receipt).toEqual({
      policy: 'best-verified',
      hostId: 'ssh:worker',
      provider: 'codex',
      label: '/remote/profile',
      choiceId: null,
      remainingPercent: 64,
      boundBy: null,
      readingAt: 1_800_000_000_000,
      readingAgeMs: 2_500,
      fableVerified: false,
      verified: null,
      considered: null,
      excluded: [],
      why: 'most fresh verified headroom on the SSH host (64%)'
    })
    const pool = relayReply()
    vi.mocked(prepareSessionPrepRemoteAccountSelection).mockResolvedValue({
      ...pool,
      account: {
        ...pool.account,
        provider: 'claude',
        pinConfigDir: false,
        configRoot: '/home/sal/.claude-accounts/pool/slot-3',
        oauthTokenFile: '/home/sal/.claude-accounts/pool/slot-3/.oauth-token'
      }
    })
    input.request.launchPreferences.model = 'claude-fable-1'
    await expect(prepareAgentSessionSshAccount(input)).resolves.toMatchObject({
      receipt: { label: 'pool slot-3', provider: 'claude', fableVerified: true },
      fableVerified: true
    })
  })

  it('refuses another host or a local projection before requesting any account', async () => {
    const { input, workspace } = fixture()
    input.request.sshAccountSelection.expectedHostId = 'ssh:other'
    await expect(prepareAgentSessionSshAccount(input)).rejects.toThrow('requested SSH host')
    await expect(prepareAgentSessionSshAccount(input)).rejects.toMatchObject({
      code: 'agent_session_host_mismatch'
    })
    input.request.sshAccountSelection.expectedHostId = 'ssh:worker'
    workspace.connectionId = null
    await expect(prepareAgentSessionSshAccount(input)).rejects.toThrow('requested SSH host')
    expect(prepareSessionPrepRemoteAccountSelection).not.toHaveBeenCalled()
  })

  it.each(['generation', 'host', 'path', 'owner'])(
    'rejects a changed %s at the final synchronous spawn boundary',
    async (change) => {
      const { input, target, workspace } = fixture()
      const prepared = await prepareAgentSessionSshAccount(input)
      if (change === 'generation') {
        target.generation++
      }
      if (change === 'host') {
        target.host = 'replacement.example'
      }
      if (change === 'path') {
        workspace.path = '/other'
      }
      if (change === 'owner') {
        workspace.repo.executionHostId = 'runtime:peer'
      }
      expect(() => prepared?.assertCurrent()).toThrow()
    }
  )

  it('does not turn a late account reply into a launch after cancellation', async () => {
    const { input } = fixture()
    const abort = new AbortController()
    input.signal = abort.signal
    vi.mocked(prepareSessionPrepRemoteAccountSelection).mockImplementation(async () => {
      abort.abort()
      return relayReply()
    })
    await expect(prepareAgentSessionSshAccount(input)).rejects.toThrow('client_disconnected')
  })

  it('refuses a reading that aged out before startup and never substitutes an account', async () => {
    const { input } = fixture()
    vi.mocked(prepareSessionPrepRemoteAccountSelection).mockResolvedValue(
      relayReply(performance.now() - 1)
    )
    await expect(prepareAgentSessionSshAccount(input)).rejects.toMatchObject({
      code: 'agent_session_account_unverified',
      message: expect.stringContaining('no longer fresh')
    })
    expect(prepareSessionPrepRemoteAccountSelection).toHaveBeenCalledTimes(1)
  })

  it('supports registered folder workspaces and rejects their replacement path', async () => {
    const { input } = fixture()
    const folder = { id: 'folder', folderPath: '/remote/folder', executionHostId: 'ssh:worker' }
    const workspace = {
      id: 'folder',
      path: folder.folderPath,
      connectionId: 'worker',
      repo: null,
      folderWorkspace: folder
    }
    const prepared = await prepareAgentSessionSshAccount({
      ...input,
      workspace,
      currentWorkspace: () => workspace
    })
    folder.folderPath = '/replacement'
    expect(() => prepared?.assertCurrent()).toThrow('workspace or target changed')
  })
})
