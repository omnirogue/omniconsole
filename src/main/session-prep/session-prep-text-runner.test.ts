import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'
import { createSessionPrepTextRunner } from './session-prep-text-runner'
import { SessionPrepAccountPreparationError } from './session-prep-ids'

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  runtimeOptions: vi.fn(),
  remoteAccount: vi.fn(),
  remoteExecute: vi.fn()
}))
vi.mock('./session-prep-remote-account', () => ({
  prepareSessionPrepRemoteAccount: mocks.remoteAccount
}))
vi.mock('../providers/ssh-git-dispatch', () => ({
  requireSshGitProvider: () => ({ executeCommitMessagePlan: mocks.remoteExecute })
}))
vi.mock('../startup/login-shell-environment', () => ({ resolveLoginShellEnvironment: vi.fn() }))
vi.mock('../ipc/model-discovery-local-path', () => ({
  resolveModelDiscoveryLocalPath: vi.fn(async (_store: unknown, path: string) => path)
}))
vi.mock('../ipc/local-worktree-runtime-options', () => ({
  getLocalGitOptionsForRegisteredWorktree: mocks.runtimeOptions
}))
vi.mock('../text-generation/commit-message-text-generation', () => ({
  generateSessionPrepTextFromPrompt: mocks.generate
}))

const store = {
  getRepos: () => [],
  getFolderWorkspaces: () => [],
  getSettings: () => ({})
} as unknown as Store
const request = {
  cwd: '/work/project',
  prompt: 'Prepare this request.',
  agent: 'claude' as const,
  model: 'sonnet',
  effort: 'medium',
  timeoutMs: 1000
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.runtimeOptions.mockReturnValue({})
  mocks.generate.mockResolvedValue({ success: true, rawOutput: '{"done":true}' })
  mocks.remoteAccount.mockResolvedValue({ CODEX_HOME: '/remote/selected' })
  mocks.remoteExecute.mockResolvedValue({ exitCode: 0, stdout: 'prepared', stderr: '' })
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('session prep account routing', () => {
  it('gives sibling SSH preparations separate cancellation lanes and the selected account', async () => {
    mocks.generate.mockImplementation(async (_prompt, _options, target) => {
      await target.execute({ binary: 'codex', args: [], stdinPayload: null }, target.cwd, 600000)
      return { success: true, rawOutput: 'prepared' }
    })
    const run = createSessionPrepTextRunner(store, () => undefined)
    const remote = { ...request, agent: 'codex' as const, connectionId: 'ssh-worker' }
    await Promise.all([run(remote), run(remote)])
    const [first, second] = mocks.remoteExecute.mock.calls
    expect(first[3]).toMatch(/^session-prep:/)
    expect(first[3]).not.toBe(second[3])
    expect(first[2]).toBe(request.timeoutMs)
    expect(first[4]).toEqual({ CODEX_HOME: '/remote/selected' })
    expect(first[5]).toBeInstanceOf(AbortSignal)
  })

  it('aborts an active SSH helper when its preparation times out', async () => {
    let signal: AbortSignal | undefined
    mocks.generate.mockImplementation(async (_prompt, _options, target) => {
      await target.execute({ binary: 'codex', args: [], stdinPayload: null }, target.cwd, 600000)
    })
    mocks.remoteExecute.mockImplementation(
      (_plan, _cwd, _timeout, _operation, _env, abortSignal) => {
        signal = abortSignal
        return new Promise(() => {})
      }
    )
    const result = createSessionPrepTextRunner(
      store,
      () => undefined
    )({
      ...request,
      connectionId: 'ssh-worker'
    })
    const refused = expect(result).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(request.timeoutMs)
    await refused
    expect(signal?.aborted).toBe(true)
  })

  it('never starts a helper after account preparation finishes beyond the deadline', async () => {
    let resolveAccount!: (value: Record<string, string>) => void
    mocks.remoteAccount.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAccount = resolve
        })
    )
    const result = createSessionPrepTextRunner(
      store,
      () => undefined
    )({
      ...request,
      connectionId: 'ssh-worker'
    })
    const refused = expect(result).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(request.timeoutMs)
    await refused
    resolveAccount({ CODEX_HOME: '/remote/selected' })
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(mocks.remoteExecute).not.toHaveBeenCalled()
  })

  it('uses the current Claude resolver and strips inherited auth for a managed profile', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/inherited/expired')
    vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-only')
    const prepareForClaudeLaunch = vi.fn(async () => ({
      provenance: 'fixture managed account',
      configDir: '/selected/healthy',
      envPatch: { CLAUDE_CONFIG_DIR: '/selected/healthy' },
      stripAuthEnv: true
    }))
    let resolvers: CommitMessageAgentEnvironmentResolvers | undefined
    const run = createSessionPrepTextRunner(store, () => resolvers)
    resolvers = { prepareForClaudeLaunch }
    await run(request)
    expect(prepareForClaudeLaunch).toHaveBeenCalledWith({ runtime: 'host' })
    const target = mocks.generate.mock.calls[0][2]
    expect(target.env.CLAUDE_CONFIG_DIR).toBe('/selected/healthy')
    expect(target.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(mocks.generate.mock.calls[0][1]).toMatchObject({
      model: 'sonnet',
      thinkingLevel: 'medium'
    })
  })

  it('uses the selected Codex home without inheriting the parent home', async () => {
    vi.stubEnv('CODEX_HOME', '/inherited/expired')
    const prepareForCodexLaunch = vi.fn(async () => '/selected/codex')
    const run = createSessionPrepTextRunner(store, () => ({ prepareForCodexLaunch }))
    await run({ ...request, agent: 'codex', model: 'gpt-6-astra', effort: 'xhigh' })
    expect(prepareForCodexLaunch).toHaveBeenCalledWith({ runtime: 'host' })
    expect(mocks.generate.mock.calls[0][2].env.CODEX_HOME).toBe('/selected/codex')
    expect(mocks.generate.mock.calls[0][1]).toMatchObject({
      model: 'gpt-6-astra',
      thinkingLevel: 'xhigh'
    })
  })

  it('does not launch on an inherited profile when routing is unavailable', async () => {
    await expect(createSessionPrepTextRunner(store, () => undefined)(request)).rejects.toThrow(
      'account routing is not available'
    )
    expect(mocks.generate).not.toHaveBeenCalled()
  })

  it('makes account preparation errors terminal before generation', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const run = createSessionPrepTextRunner(store, () => ({
        prepareForCodexLaunch: async () => {
          throw new Error('Sign-in unavailable')
        }
      }))
      await expect(run({ ...request, agent: 'codex' })).rejects.toBeInstanceOf(
        SessionPrepAccountPreparationError
      )
      expect(mocks.generate).not.toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
  })

  it('passes the WSL target to the existing account resolver', async () => {
    mocks.runtimeOptions.mockReturnValue({ wslDistro: 'Ubuntu' })
    const prepareForCodexLaunch = vi.fn(async () => null)
    await createSessionPrepTextRunner(store, () => ({ prepareForCodexLaunch }))({
      ...request,
      agent: 'codex'
    })
    expect(prepareForCodexLaunch).toHaveBeenCalledWith({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    expect(mocks.generate.mock.calls[0][2].wslDistro).toBe('Ubuntu')
  })

  it('surfaces a CLI auth refusal to the dependent pipeline', async () => {
    mocks.generate.mockResolvedValue({
      success: false,
      error: 'Failed to authenticate: OAuth session expired'
    })
    const run = createSessionPrepTextRunner(store, () => ({
      prepareForCodexLaunch: async () => null
    }))
    await expect(run({ ...request, agent: 'codex' })).rejects.toThrow('Failed to authenticate')
    expect(mocks.generate).toHaveBeenCalledTimes(1)
  })
})
