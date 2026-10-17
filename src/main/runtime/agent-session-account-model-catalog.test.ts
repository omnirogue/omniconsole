import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoverAgentSessionAccountCatalog } from './agent-session-account-model-catalog'
import {
  discoverCommitMessageModelsLocal,
  discoverCommitMessageModelsRemote
} from '../text-generation/commit-message-text-generation'
import { requireSshGitProvider } from '../providers/ssh-git-dispatch'
import type { SessionPrepRouterRequest } from '../session-prep/session-prep-router-types'

vi.mock('../text-generation/commit-message-text-generation', () => ({
  discoverCommitMessageModelsLocal: vi.fn(),
  discoverCommitMessageModelsRemote: vi.fn()
}))
vi.mock('../providers/ssh-git-dispatch', () => ({ requireSshGitProvider: vi.fn() }))

const request: SessionPrepRouterRequest = {
  title: 'Native launch',
  brief: 'Fix one typo',
  provider: 'codex',
  executionTarget: { path: '/owner/project', hostId: 'local' }
}
const listing = {
  success: true as const,
  catalogOrigin: 'probe' as const,
  defaultModelId: 'gpt-6-astra',
  capability: {
    id: 'codex' as const,
    label: 'Codex',
    modelSource: 'dynamic' as const,
    models: [],
    defaultModelId: 'gpt-6-astra'
  },
  models: [{ id: 'gpt-6-astra', label: 'Astra' }]
}

afterEach(() => {
  vi.resetAllMocks()
  vi.useRealTimers()
})

describe('verified execution-account catalog', () => {
  it('probes the chosen local account and never substitutes another account listing', async () => {
    vi.mocked(discoverCommitMessageModelsLocal).mockResolvedValue(listing)
    const result = await discoverAgentSessionAccountCatalog(request, {
      CODEX_HOME: '/chosen/account'
    })
    expect(discoverCommitMessageModelsLocal).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({ CODEX_HOME: '/chosen/account' }),
      undefined,
      expect.objectContaining({ cwd: '/owner/project', force: true })
    )
    expect(result.agents).toEqual([{ provider: 'codex', models: listing.models, discovered: true }])
    expect(result.agents[0]?.models.some((model) => model.id === 'gpt-6-luna')).toBe(false)
  })

  it('pins the SSH probe environment and bypasses the host-only discovery cache', async () => {
    const execute = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    vi.mocked(requireSshGitProvider).mockReturnValue({ executeCommitMessagePlan: execute } as never)
    vi.mocked(discoverCommitMessageModelsRemote).mockImplementation(async (_agent, cwd, run) => {
      await run(
        { binary: 'codex', args: ['models'], stdinPayload: null, label: 'Codex' },
        cwd,
        90_000
      )
      return listing
    })
    const remoteRequest = {
      ...request,
      executionTarget: { path: '/remote/project', hostId: 'ssh:worker', connectionId: 'worker' }
    }
    await discoverAgentSessionAccountCatalog(remoteRequest, { CODEX_HOME: '/remote/chosen' })
    expect(vi.mocked(discoverCommitMessageModelsRemote).mock.calls[0]).toHaveLength(4)
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ binary: 'codex' }),
      '/remote/project',
      3_000,
      'model-discovery',
      { CODEX_HOME: '/remote/chosen' },
      expect.any(AbortSignal)
    )
    expect(discoverCommitMessageModelsLocal).not.toHaveBeenCalled()
  })

  it('does not claim a seed catalog proves the selected account can launch a model', async () => {
    vi.mocked(discoverCommitMessageModelsLocal).mockResolvedValue({
      ...listing,
      catalogOrigin: 'spec'
    })
    expect(
      (await discoverAgentSessionAccountCatalog(request, { CODEX_HOME: '/chosen' })).agents[0]
    ).toMatchObject({ discovered: false, models: [] })
  })

  it('does not probe without a verified account home', async () => {
    expect((await discoverAgentSessionAccountCatalog(request, {})).agents[0]).toMatchObject({
      discovered: false,
      models: []
    })
    expect(discoverCommitMessageModelsLocal).not.toHaveBeenCalled()
    expect(discoverCommitMessageModelsRemote).not.toHaveBeenCalled()
  })

  it('keeps SSH failure unavailable without running locally', async () => {
    vi.mocked(requireSshGitProvider).mockImplementation(() => {
      throw new Error('offline')
    })
    const remoteRequest = {
      ...request,
      executionTarget: { path: '/remote/project', hostId: 'ssh:worker', connectionId: 'worker' }
    }
    expect(
      (await discoverAgentSessionAccountCatalog(remoteRequest, { CODEX_HOME: '/chosen' })).agents[0]
    ).toMatchObject({ discovered: false, models: [] })
    expect(discoverCommitMessageModelsLocal).not.toHaveBeenCalled()
  })
})

describe('bounded shared account probes', () => {
  it('coalesces identical account probes and isolates caller cancellation', async () => {
    let finish!: (value: typeof listing) => void
    vi.mocked(discoverCommitMessageModelsLocal).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const caller = new AbortController()
    const first = discoverAgentSessionAccountCatalog(
      request,
      { CODEX_HOME: '/coalesced' },
      undefined,
      caller.signal
    )
    const second = discoverAgentSessionAccountCatalog(request, { CODEX_HOME: '/coalesced' })
    await vi.waitFor(() => expect(discoverCommitMessageModelsLocal).toHaveBeenCalledOnce())
    caller.abort()
    expect((await first).agents[0]?.discovered).toBe(false)
    expect(vi.mocked(discoverCommitMessageModelsLocal).mock.calls[0][3]?.signal?.aborted).toBe(
      false
    )
    finish(listing)
    expect((await second).agents[0]?.discovered).toBe(true)
  })

  it('allows only two account probes at once and does not mix account environments', async () => {
    const finishes: ((value: typeof listing) => void)[] = []
    vi.mocked(discoverCommitMessageModelsLocal).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishes.push(resolve)
        })
    )
    const jobs = ['/one', '/two', '/three'].map((home) =>
      discoverAgentSessionAccountCatalog(request, { CODEX_HOME: home })
    )
    await vi.waitFor(() => expect(finishes).toHaveLength(2))
    expect(discoverCommitMessageModelsLocal).toHaveBeenCalledTimes(2)
    finishes[0]!(listing)
    await jobs[0]
    await vi.waitFor(() => expect(finishes).toHaveLength(3))
    finishes[1]!(listing)
    finishes[2]!(listing)
    expect((await Promise.all(jobs)).every((value) => value.agents[0]?.discovered)).toBe(true)
    expect(
      vi.mocked(discoverCommitMessageModelsLocal).mock.calls.map((call) => call[1]?.CODEX_HOME)
    ).toEqual(['/one', '/two', '/three'])
  })

  it('aborts owned probes at the foreground deadline and expires queued work', async () => {
    vi.useFakeTimers()
    vi.mocked(discoverCommitMessageModelsLocal).mockImplementation(
      (_provider, _env, _cmd, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), {
            once: true
          })
        })
    )
    const jobs = ['/timeout-one', '/timeout-two', '/timeout-three'].map((home) =>
      discoverAgentSessionAccountCatalog(request, { CODEX_HOME: home })
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(discoverCommitMessageModelsLocal).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(3001)
    expect((await Promise.all(jobs)).every((value) => !value.agents[0]?.discovered)).toBe(true)
    expect(discoverCommitMessageModelsLocal).toHaveBeenCalledTimes(2)
    expect(
      vi
        .mocked(discoverCommitMessageModelsLocal)
        .mock.calls.every((call) => call[3]?.signal?.aborted)
    ).toBe(true)
  })
})
