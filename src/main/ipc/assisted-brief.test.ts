import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { CommitMessageGenerationTarget } from '../text-generation/commit-message-text-generation'
import { sourceControlGenerationTimeoutMs } from '../text-generation/source-control-generation-limits'

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  cancelLocal: vi.fn(),
  prepareEnv: vi.fn(),
  getProvider: vi.fn()
}))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('./filesystem', () => ({
  resolveModelDiscoveryLocalPath: vi.fn(async (_store: unknown, path: string) => `${path}/resolved`)
}))
vi.mock('./local-worktree-runtime-options', () => ({
  getLocalGitOptionsForRegisteredWorktree: vi.fn(() => ({}))
}))
vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: mocks.getProvider,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE: 'SSH is not connected.'
}))
vi.mock('../text-generation/commit-message-agent-environment', () => ({
  prepareLocalCommitMessageAgentEnv: mocks.prepareEnv
}))
vi.mock('../text-generation/commit-message-text-generation', () => ({
  generateAssistedBriefTextFromPrompt: mocks.generate,
  cancelAssistedBriefTextLocal: mocks.cancelLocal
}))

const { cancelAssistedBrief, generateAssistedBrief } = await import('./assisted-brief')

const store = {
  getSettings: () => ({ agentCmdOverrides: { claude: ' /opt/bin/claude ' } })
} as unknown as Store
const deps = { store }
const request = {
  purpose: 'draft',
  worktreePath: '/work/app',
  agent: 'claude',
  model: 'claude-fable-5-1[1m]',
  prompt: 'Draft a brief.'
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.prepareEnv.mockResolvedValue({ ok: true })
  mocks.generate.mockResolvedValue({
    success: true,
    rawOutput: '{"outcome":"x"}',
    agentLabel: 'Claude'
  })
})

describe('assisted brief drafting runner', () => {
  it('rejects malformed requests and agents without a read-only one-shot mode', async () => {
    expect(await generateAssistedBrief(deps, { ...request, prompt: '' })).toMatchObject({
      ok: false
    })
    expect(await generateAssistedBrief(deps, { ...request, extra: true })).toMatchObject({
      ok: false
    })
    expect(await generateAssistedBrief(deps, { ...request, agent: 'grok' })).toMatchObject({
      ok: false
    })
    expect(mocks.generate).not.toHaveBeenCalled()
  })

  it('drafts locally with the favourite’s exact model and the user’s command override', async () => {
    expect(await generateAssistedBrief(deps, { ...request, effort: 'high' })).toEqual({
      ok: true,
      text: '{"outcome":"x"}',
      actorLabel: 'Claude'
    })
    expect(mocks.generate).toHaveBeenCalledWith(
      'Draft a brief.',
      {
        agentId: 'claude',
        model: 'claude-fable-5-1[1m]',
        thinkingLevel: 'high',
        agentCommandOverride: '/opt/bin/claude'
      },
      { kind: 'local', cwd: '/work/app/resolved' }
    )
  })

  it('drafts under the favourite’s saved account, resolved from main-process settings', async () => {
    const withProfile = {
      getSettings: () => ({
        agentAccountProfiles: [
          { id: 'work', label: 'Work', agent: 'claude', configDir: '/cfg/work' }
        ]
      })
    } as unknown as Store
    await generateAssistedBrief(
      { store: withProfile },
      { ...request, accountChoiceId: 'profile:work' }
    )
    const target = mocks.generate.mock.calls[0][2] as CommitMessageGenerationTarget
    expect(target.kind === 'local' && target.env?.CLAUDE_CONFIG_DIR).toBe('/cfg/work')
    await generateAssistedBrief(
      { store: withProfile },
      { ...request, accountChoiceId: 'profile:gone' }
    )
    const fallback = mocks.generate.mock.calls[1][2] as CommitMessageGenerationTarget
    expect(fallback).toEqual({ kind: 'local', cwd: '/work/app/resolved' })
  })

  it('runs on the SSH host that owns the workspace', async () => {
    const provider = { executeCommitMessagePlan: vi.fn(), cancelNonInteractiveExec: vi.fn() }
    mocks.getProvider.mockReturnValue(provider)
    await generateAssistedBrief(deps, { ...request, connectionId: 'ssh-1' })
    const target = mocks.generate.mock.calls[0][2] as CommitMessageGenerationTarget
    expect(target).toMatchObject({ kind: 'remote', cwd: '/work/app' })
    const plan = { binary: 'claude', args: [], stdinPayload: 'x', label: 'Claude' }
    if (target.kind === 'remote') {
      await target.execute(plan, '/work/app', 1_000, 'assisted-brief')
    }
    expect(provider.executeCommitMessagePlan).toHaveBeenCalledWith(
      plan,
      '/work/app',
      1_000,
      'assisted-brief'
    )
    mocks.getProvider.mockReturnValue(undefined)
    expect(await generateAssistedBrief(deps, { ...request, connectionId: 'ssh-2' })).toEqual({
      ok: false,
      error: 'SSH is not connected.'
    })
  })

  it('reports a cancelled run without an error to show', async () => {
    mocks.generate.mockResolvedValue({
      success: false,
      error: 'Generation canceled.',
      canceled: true
    })
    expect(await generateAssistedBrief(deps, request)).toEqual({
      ok: false,
      error: 'Generation canceled.',
      canceled: true
    })
  })

  it('cancels the run on the computer that is running it', async () => {
    await cancelAssistedBrief(store, { worktreePath: '/work/app' })
    expect(mocks.cancelLocal).toHaveBeenCalledWith('/work/app/resolved')
    const provider = { cancelNonInteractiveExec: vi.fn() }
    mocks.getProvider.mockReturnValue(provider)
    await cancelAssistedBrief(store, { worktreePath: '/srv/app', connectionId: 'ssh-1' })
    expect(provider.cancelNonInteractiveExec).toHaveBeenCalledWith('/srv/app', 'assisted-brief')
  })

  it('gives a brief more time than a commit message', () => {
    expect(sourceControlGenerationTimeoutMs('assisted-brief')).toBe(180_000)
    expect(sourceControlGenerationTimeoutMs('commit-message')).toBe(60_000)
  })
})
