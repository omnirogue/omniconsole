import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountCapacityRow } from '../../../../shared/provider-account-capacity'
import { prepareReadyPaneLaunch } from './prepare-ready-pane-launch'

const mocks = vi.hoisted(() => ({
  scope: 'profile',
  owner: 'local' as string | null,
  settings: { activeRuntimeEnvironmentId: null as string | null },
  route: vi.fn(),
  status: vi.fn(),
  readiness: vi.fn(),
  snapshot: vi.fn(),
  models: vi.fn(),
  refresh: vi.fn(),
  ensure: vi.fn(),
  cache: vi.fn(),
  probes: vi.fn(),
  detection: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: mocks.settings,
      refreshDetectedAgents: mocks.detection,
      refreshRuntimeDetectedAgents: mocks.detection
    })
  }
}))
vi.mock('@/lib/console-account-scope', () => ({ selectConsoleAccountScope: () => mocks.scope }))
vi.mock('@/store/terminals/terminal-workspace-routing', () => ({
  resolveTerminalCreationRoute: mocks.route
}))
vi.mock('./ready-pane-options', () => ({
  readyPaneOwner: () => ({
    owner: mocks.owner,
    settings: mocks.settings,
    target: { kind: 'local' }
  }),
  readyAccountCacheKey: () => 'key',
  useReadyAccountCache: { setState: mocks.cache }
}))
vi.mock('../build-review/use-build-review-agent-models', () => ({
  resolveBuildReviewDiscoveryContext: () => ({ runtime: { settings: mocks.settings } })
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  getRuntimeEnvironmentStatus: mocks.status,
  callRuntimeRpc: mocks.readiness
}))
vi.mock('@/runtime/runtime-provider-accounts-client', () => ({
  fetchProviderAccountsSnapshot: mocks.snapshot
}))
vi.mock('@/runtime/runtime-git-client', () => ({
  discoverRuntimeCommitMessageModels: mocks.models
}))
vi.mock('@/hooks/work-agent-model-probes', () => ({
  useWorkAgentModelProbes: { setState: mocks.probes }
}))
vi.mock('@/hooks/useWorkAgentCapabilities', () => ({ workAgentModelProbeOwner: () => 'owner' }))
vi.mock('@/hooks/useWorkProviderUsage', () => ({ refreshWorkProviderUsage: mocks.refresh }))
vi.mock('@/lib/company-folder-home', () => ({ getCompanyFolderHome: async () => '/home/test' }))
vi.mock('@/lib/company-session-workspace', () => ({ ensureCompanySessionWorkspace: mocks.ensure }))
vi.mock('@/lib/resolved-worktree-execution-host', () => ({
  getResolvedExecutionHostIdForWorktree: () => 'local'
}))

const row = (patch: Partial<AccountCapacityRow> = {}): AccountCapacityRow => ({
  provider: 'codex',
  accountId: 'one',
  choiceId: 'managed:one',
  email: null,
  detail: null,
  isDefault: true,
  isSystem: false,
  fiveHour: null,
  weekly: { remainingPercent: 80, resetsAt: null, windowMinutes: 10080 },
  fableWeekly: null,
  state: 'ready',
  signedOutReason: null,
  limitedUntil: null,
  readingAt: Date.now(),
  readingPausedUntil: null,
  sourceLabel: null,
  launchEnv: { CODEX_HOME: '/host/account' },
  ...patch
})
const input = () => ({
  scope: 'profile',
  workspace: 'folder:one',
  provider: 'codex' as const,
  draft: { text: 'Task', model: 'model', effort: 'high', account: 'managed:one' }
})
beforeEach(() => {
  vi.clearAllMocks()
  mocks.scope = 'profile'
  mocks.owner = 'local'
  mocks.settings.activeRuntimeEnvironmentId = null
  mocks.route.mockReset().mockReturnValue({ runtimeEnvironmentId: null, connectionId: null })
  mocks.status.mockReset().mockResolvedValue({})
  mocks.readiness.mockReset().mockResolvedValue({ account: { verified: false } })
  mocks.snapshot
    .mockReset()
    .mockResolvedValue({ rateLimits: { accountCapacity: { codex: [row()] } } })
  mocks.models.mockReset().mockResolvedValue({
    success: true,
    models: [
      {
        id: 'model',
        label: 'Model',
        thinkingLevels: [{ id: 'high', label: 'High' }]
      }
    ]
  })
  mocks.ensure.mockReset().mockResolvedValue({ ok: true, workspace: { id: 'work' } })
  mocks.detection.mockReset().mockResolvedValue(['codex'])
})
describe('ready-pane verification on Send', () => {
  it('pins the exact host account and preferences without creating a workspace', async () => {
    expect(await prepareReadyPaneLaunch(input())).toMatchObject({
      worktreeId: 'folder:one',
      agent: 'codex',
      launchEnv: { CODEX_HOME: '/host/account' },
      launchPreferences: { model: 'model', effort: 'high' }
    })
    expect(mocks.ensure).not.toHaveBeenCalled()
  })
  it('refuses an unresolved route before any account or model probe', async () => {
    mocks.route.mockImplementation(() => {
      throw new Error('Disconnected')
    })
    await expect(prepareReadyPaneLaunch(input())).rejects.toThrow('Disconnected')
    expect(mocks.readiness).not.toHaveBeenCalled()
    expect(mocks.snapshot).not.toHaveBeenCalled()
    expect(mocks.models).not.toHaveBeenCalled()
  })
  it('checks paired host contact before probing and never falls back locally', async () => {
    mocks.owner = 'environment:host'
    mocks.settings.activeRuntimeEnvironmentId = 'host'
    mocks.route.mockReturnValue({ runtimeEnvironmentId: 'host', connectionId: null })
    mocks.status.mockRejectedValue(new Error('Host offline'))
    await expect(prepareReadyPaneLaunch(input())).rejects.toThrow('Host offline')
    expect(mocks.readiness).not.toHaveBeenCalled()
    expect(mocks.refresh).not.toHaveBeenCalled()
    expect(mocks.ensure).not.toHaveBeenCalled()
  })
  it('does not copy a desktop account profile into an SSH launch', async () => {
    mocks.route.mockReturnValue({ runtimeEnvironmentId: null, connectionId: 'ssh' })
    await expect(prepareReadyPaneLaunch(input())).rejects.toThrow('SSH host')
    expect(mocks.snapshot).not.toHaveBeenCalled()
  })
  it.each([
    row({ readingAt: Date.now() - 120_000 }),
    row({ state: 'signed-out', launchEnv: null }),
    row({ state: 'limited' }),
    row({ readingAt: null })
  ])('refuses unverified or exhausted selected accounts', async (account) => {
    mocks.snapshot.mockResolvedValue({
      rateLimits: { accountCapacity: { codex: [account, row({ choiceId: 'other' })] } }
    })
    await expect(prepareReadyPaneLaunch(input())).rejects.toThrow(/selected account/i)
    expect(mocks.ensure).not.toHaveBeenCalled()
  })
  it('refuses a missing exact account even when another account is ready', async () => {
    mocks.snapshot.mockResolvedValue({
      rateLimits: { accountCapacity: { codex: [row({ choiceId: 'other' })] } }
    })
    await expect(prepareReadyPaneLaunch(input())).rejects.toThrow('selected account')
  })
  it.each([
    { model: 'retired', effort: 'high' },
    { model: 'model', effort: 'unsupported' }
  ])('keeps an unavailable model or effort explicit', async (preferences) => {
    const request = input()
    request.draft = { ...request.draft, ...preferences }
    await expect(prepareReadyPaneLaunch(request)).rejects.toThrow('unavailable')
    expect(mocks.ensure).not.toHaveBeenCalled()
  })
  it('fences an account change during the host readiness request', async () => {
    mocks.readiness.mockImplementation(async () => {
      mocks.scope = 'other'
      return {}
    })
    await expect(prepareReadyPaneLaunch(input())).rejects.toThrow('account changed')
    expect(mocks.snapshot).not.toHaveBeenCalled()
  })
  it('resolves Work only after verification and previews the actual Work path', async () => {
    await prepareReadyPaneLaunch({ ...input(), workspace: '' })
    expect(mocks.readiness).toHaveBeenCalledWith(
      { kind: 'local' },
      'terminal.agentLaunchReadiness',
      expect.objectContaining({ worktree: 'path:/home/test/Work', preview: true }),
      expect.anything()
    )
    expect(mocks.ensure).toHaveBeenCalledOnce()
  })
})
