import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeCreateAgentSessionRequest } from '../../shared/agent-session-host-authority'
import type { AccountCapacityRow, CapacityProvider } from '../../shared/provider-account-capacity'
import {
  prepareAgentSessionLocalAccount,
  previewLocalLaunchAccount,
  WSL_ACCOUNT_REFUSAL,
  type LaunchAccountCapacity
} from './agent-session-local-account'
import type { AgentLaunchWorkspace } from './agent-session-ssh-account'

vi.mock('../local-host-label', () => ({ localHostLabel: () => 'studio' }))

const NOW = 1_800_000_000_000

function row(change: Partial<AccountCapacityRow> = {}): AccountCapacityRow {
  return {
    provider: 'claude',
    accountId: 'a',
    choiceId: 'managed:a',
    email: 'a@example.com',
    detail: null,
    isDefault: true,
    isSystem: false,
    fiveHour: { remainingPercent: 70, resetsAt: null, windowMinutes: 300 },
    weekly: { remainingPercent: 50, resetsAt: null, windowMinutes: 10080 },
    fableWeekly: null,
    state: 'ready',
    signedOutReason: null,
    limitedUntil: null,
    readingAt: NOW,
    readingPausedUntil: null,
    sourceLabel: null,
    launchEnv: { CLAUDE_CONFIG_DIR: '/accounts/a/session' },
    ...change
  }
}

function fakeCapacity(initial: AccountCapacityRow[]) {
  const state = { rows: initial }
  const of = (provider: CapacityProvider) => state.rows.filter((r) => r.provider === provider)
  const capacity = {
    resolve: vi.fn<LaunchAccountCapacity['resolve']>(async () => {}),
    snapshot: vi.fn<LaunchAccountCapacity['snapshot']>(() => ({
      claude: of('claude'),
      codex: of('codex'),
      builtAt: Date.now()
    })),
    refresh: vi.fn<LaunchAccountCapacity['refresh']>(async () => ({}) as never)
  }
  return { state, capacity }
}

function workspace(change: Partial<AgentLaunchWorkspace> = {}): AgentLaunchWorkspace {
  return {
    id: 'repo::/work',
    path: '/work',
    connectionId: null,
    repo: { id: 'repo', path: '/repo', executionHostId: null },
    folderWorkspace: null,
    ...change
  }
}

function request(
  change: Partial<RuntimeCreateAgentSessionRequest> = {}
): RuntimeCreateAgentSessionRequest {
  return {
    clientOperationId: 'unused',
    worktree: 'id:repo::/work',
    agent: 'claude',
    viewMode: 'terminal',
    launchPreferences: { model: 'opus' },
    sshAccountSelection: {
      policy: 'best-verified',
      expectedHostId: 'local',
      expectedRuntimeId: '11111111-1111-4111-8111-111111111111'
    },
    ...change
  }
}

function prepare(
  capacity: LaunchAccountCapacity | null,
  change: Partial<RuntimeCreateAgentSessionRequest> = {},
  target = workspace(),
  signal?: AbortSignal
) {
  return prepareAgentSessionLocalAccount({
    request: request(change),
    workspace: target,
    currentWorkspace: () => target,
    runsInWsl: () => false,
    capacity,
    signal
  })
}

const FABLE = { remainingPercent: 40, resetsAt: null, windowMinutes: 10080 }

/** What a usage fetch returns, or a statusline post when `live`. */
function reading(updatedAt: number, live = false) {
  return {
    status: 'ok',
    updatedAt,
    ...(live ? { usageMetadata: { source: 'live-session' } } : {})
  } as never
}

describe('local best-verified launch account', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("pins the chosen row's non-empty CLAUDE_CONFIG_DIR or CODEX_HOME", async () => {
    const claude = fakeCapacity([row()])
    await expect(prepare(claude.capacity)).resolves.toMatchObject({
      env: { CLAUDE_CONFIG_DIR: '/accounts/a/session' },
      receipt: { hostId: 'local', choiceId: 'managed:a', remainingPercent: 50 }
    })
    const codex = fakeCapacity([
      row({ provider: 'codex', launchEnv: { CODEX_HOME: '/accounts/codex-a' } })
    ])
    await expect(
      prepare(codex.capacity, { agent: 'codex', launchPreferences: undefined })
    ).resolves.toMatchObject({ env: { CODEX_HOME: '/accounts/codex-a' } })
    const empty = fakeCapacity([row({ launchEnv: { CLAUDE_CONFIG_DIR: '' } })])
    await expect(prepare(empty.capacity)).rejects.toMatchObject({
      code: 'agent_session_account_unverified',
      message: expect.stringContaining('no launch home')
    })
  })

  it('force-refreshes only rows older than 30 s that are not limited, signed out or paused, at most 4 at a time', async () => {
    const stale = Array.from({ length: 6 }, (_, index) =>
      row({ accountId: `s${index}`, choiceId: `managed:s${index}`, readingAt: NOW - 45_000 })
    )
    const { capacity } = fakeCapacity([
      ...stale,
      row({ accountId: 'recent', choiceId: 'managed:recent', readingAt: NOW - 5_000 }),
      row({ accountId: 'lim', choiceId: 'managed:lim', state: 'limited', readingAt: null }),
      row({ accountId: 'out', choiceId: 'managed:out', state: 'signed-out', launchEnv: null }),
      row({
        accountId: 'wait',
        choiceId: 'managed:wait',
        state: 'usable',
        readingAt: NOW - 45_000,
        readingPausedUntil: NOW + 60_000
      })
    ])
    let inflight = 0
    let peak = 0
    capacity.refresh.mockImplementation(async () => {
      inflight += 1
      peak = Math.max(peak, inflight)
      await new Promise((resolve) => setTimeout(resolve, 10))
      inflight -= 1
      return {} as never
    })
    const pending = prepare(capacity)
    await vi.advanceTimersByTimeAsync(100)
    await pending
    expect(capacity.refresh.mock.calls.map((call) => call[1]).sort()).toEqual(
      stale.map((entry) => entry.accountId).sort()
    )
    expect(capacity.refresh.mock.calls.every((call) => call[2]?.force === true)).toBe(true)
    expect(peak).toBe(4)
  })

  it('does not force the same row twice within 30 s even after a failed fetch', async () => {
    const { capacity } = fakeCapacity([row({ state: 'usable', readingAt: null })])
    capacity.refresh.mockRejectedValue(new Error('usage endpoint down'))
    const preview = () =>
      previewLocalLaunchAccount({
        agent: 'claude',
        model: 'opus',
        path: '/work',
        runsInWsl: false,
        capacity
      })
    await expect(preview()).resolves.toMatchObject({ verified: false })
    await expect(preview()).resolves.toMatchObject({ verified: false })
    expect(capacity.refresh).toHaveBeenCalledTimes(1)
    vi.setSystemTime(NOW + 30_000)
    await preview()
    expect(capacity.refresh).toHaveBeenCalledTimes(2)
  })

  it('leaves a reading that misses the 15 s deadline unverified', async () => {
    const { capacity } = fakeCapacity([row({ readingAt: NOW - 61_000 })])
    capacity.refresh.mockReturnValue(new Promise<never>(() => {}))
    const pending = prepare(capacity)
    const settled = expect(pending).rejects.toMatchObject({
      code: 'agent_session_account_unverified',
      message: expect.stringMatching(
        /^No claude account on studio has .*a@example\.com: reading \d+ s old.*Nothing launched\.$/
      )
    })
    await vi.advanceTimersByTimeAsync(15_000)
    await settled
  })

  it('refuses an SSH workspace, a WSL path, chat view, a codexAccountId pin, other agents and a runtime without account services', async () => {
    const { capacity } = fakeCapacity([row()])
    await expect(
      prepare(capacity, {}, workspace({ connectionId: 'worker' }))
    ).rejects.toMatchObject({ code: 'agent_session_host_mismatch' })
    await expect(
      prepare(capacity, {}, workspace({ path: '//wsl.localhost/Ubuntu/home/me/work' }))
    ).rejects.toMatchObject({
      code: 'agent_session_account_unverified',
      message: expect.stringContaining('WSL')
    })
    await expect(prepare(capacity, { viewMode: 'chat' })).rejects.toMatchObject({
      code: 'agent_session_account_unverified'
    })
    await expect(
      prepare(capacity, { launchPreferences: { codexAccountId: 'pinned' } })
    ).rejects.toMatchObject({ code: 'agent_session_account_unverified' })
    await expect(prepare(capacity, { agent: 'gemini' })).rejects.toMatchObject({
      code: 'agent_session_account_unverified'
    })
    await expect(prepare(null)).rejects.toMatchObject({
      code: 'agent_session_account_unverified',
      message: expect.stringContaining('without account services')
    })
    expect(capacity.resolve).not.toHaveBeenCalled()
    expect(capacity.refresh).not.toHaveBeenCalled()
  })

  it('accepts folder workspaces and setups stamped runtime:<id>', async () => {
    const { capacity } = fakeCapacity([row()])
    const folder = workspace({
      id: 'folder-1',
      path: '/notes',
      repo: null,
      folderWorkspace: { id: 'folder-1', folderPath: '/notes', executionHostId: 'runtime:env-1' }
    })
    await expect(prepare(capacity, {}, folder)).resolves.toMatchObject({
      env: { CLAUDE_CONFIG_DIR: '/accounts/a/session' }
    })
    const stamped = workspace({ repo: { id: 'repo', path: '/repo', executionHostId: 'runtime:x' } })
    await expect(prepare(capacity, {}, stamped)).resolves.not.toBeNull()
    const elsewhere = workspace({ repo: { id: 'repo', path: '/repo', executionHostId: 'ssh:w' } })
    await expect(prepare(capacity, {}, elsewhere)).rejects.toMatchObject({
      code: 'agent_session_host_mismatch'
    })
  })

  it.each(['aged', 'limited', 'launchEnv', 'default', 'workspace', 'abort'] as const)(
    'assertCurrent refuses after 60 s, when the row turns limited, when its launchEnv changes, when a managed default replaces a System pick, when the workspace changes, or after abort: %s',
    async (change) => {
      const system = row({
        accountId: null,
        choiceId: 'system',
        isSystem: true,
        isDefault: true,
        launchEnv: { CLAUDE_CONFIG_DIR: '/home/me/.claude' }
      })
      const managed = row({ isDefault: false, state: 'signed-out', launchEnv: null })
      const { state, capacity } = fakeCapacity(change === 'default' ? [system, managed] : [row()])
      const abort = new AbortController()
      let current = workspace()
      const prepared = await prepareAgentSessionLocalAccount({
        request: request(),
        workspace: workspace(),
        currentWorkspace: () => current,
        runsInWsl: () => false,
        capacity,
        signal: abort.signal
      })
      expect(() => prepared?.assertCurrent()).not.toThrow()
      if (change === 'aged') {
        vi.setSystemTime(NOW + 61_000)
      } else if (change === 'limited') {
        state.rows = [row({ state: 'limited' })]
      } else if (change === 'launchEnv') {
        state.rows = [row({ launchEnv: { CLAUDE_CONFIG_DIR: '/accounts/other' } })]
      } else if (change === 'default') {
        state.rows = [
          { ...system, isDefault: false },
          { ...managed, isDefault: true }
        ]
      } else if (change === 'workspace') {
        current = workspace({ path: '/moved' })
      } else {
        abort.abort()
      }
      expect(() => prepared?.assertCurrent()).toThrow(
        change === 'abort'
          ? 'client_disconnected'
          : change === 'workspace'
            ? 'workspace changed'
            : 'no longer verified'
      )
    }
  )

  it('assertCurrent accepts a newer fresh reading for the same row', async () => {
    const { state, capacity } = fakeCapacity([row()])
    const prepared = await prepare(capacity)
    vi.setSystemTime(NOW + 50_000)
    state.rows = [
      row({
        readingAt: NOW + 45_000,
        weekly: { remainingPercent: 20, resetsAt: null, windowMinutes: 10080 }
      })
    ]
    expect(() => prepared?.assertCurrent()).not.toThrow()
  })

  it('preview returns the same pick without a pin or fence', async () => {
    const { capacity } = fakeCapacity([
      row(),
      row({
        accountId: 'b',
        choiceId: 'managed:b',
        isDefault: false,
        weekly: { remainingPercent: 30, resetsAt: null, windowMinutes: 10080 }
      })
    ])
    const prepared = await prepare(capacity)
    const preview = await previewLocalLaunchAccount({
      agent: 'claude',
      model: 'opus',
      path: '/work',
      runsInWsl: false,
      capacity
    })
    expect(preview).toEqual({ verified: true, receipt: prepared?.receipt })
    expect(preview).not.toHaveProperty('env')
    expect(preview).not.toHaveProperty('assertCurrent')
  })

  it('a launch arriving while another forces a row waits for that fetch instead of refusing', async () => {
    const { state, capacity } = fakeCapacity([row({ readingAt: NOW - 120_000 })])
    let land = () => {}
    capacity.refresh.mockImplementation(
      () =>
        new Promise((resolve) => {
          land = () => {
            state.rows = [row({ readingAt: Date.now() })]
            resolve(reading(Date.now()))
          }
        })
    )
    const launches = [prepare(capacity), prepare(capacity), prepare(capacity)]
    await vi.advanceTimersByTimeAsync(2_000)
    land()
    for (const launch of launches) {
      await expect(launch).resolves.toMatchObject({ receipt: { choiceId: 'managed:a' } })
    }
    expect(capacity.refresh).toHaveBeenCalledTimes(1)
  })

  it('re-reads a Fable window a live statusline post carried over before counting it', async () => {
    const { state, capacity } = fakeCapacity([row({ readingAt: NOW - 5_000, fableWeekly: FABLE })])
    const fable = { launchPreferences: { model: 'claude-fable-1' } }
    capacity.refresh.mockResolvedValue({ status: 'error', updatedAt: NOW - 3_600_000 } as never)
    await expect(prepare(capacity, fable)).rejects.toMatchObject({
      code: 'agent_session_account_unverified',
      message: expect.stringContaining('a@example.com: no current Fable reading')
    })
    expect(capacity.refresh).toHaveBeenCalledWith('claude', 'a', { force: true })

    vi.setSystemTime(NOW + 30_000)
    capacity.refresh.mockResolvedValue(reading(NOW + 30_000))
    const prepared = await prepare(capacity, fable)
    expect(prepared).toMatchObject({
      fableVerified: true,
      receipt: { remainingPercent: 40, boundBy: 'fable-weekly', fableVerified: true }
    })
    // A live post keeps readingAt current, but the Fable reading itself ages past 60 s.
    vi.setSystemTime(NOW + 91_000)
    state.rows = [row({ readingAt: NOW + 90_000, fableWeekly: FABLE })]
    expect(() => prepared?.assertCurrent()).toThrow('no longer verified')
  })

  it('never verifies Fable from a live statusline reading when the model may resolve to Fable', async () => {
    const live = fakeCapacity([row({ fableWeekly: FABLE })])
    live.capacity.refresh.mockResolvedValue(reading(NOW, true))
    await expect(prepare(live.capacity, { launchPreferences: undefined })).resolves.toMatchObject({
      fableVerified: false,
      receipt: { fableVerified: false }
    })
    expect(live.capacity.refresh).toHaveBeenCalledWith('claude', 'a', { force: true })

    const fetched = fakeCapacity([row({ fableWeekly: FABLE })])
    fetched.capacity.refresh.mockResolvedValue(reading(NOW))
    await expect(
      prepare(fetched.capacity, { launchPreferences: undefined })
    ).resolves.toMatchObject({ fableVerified: true })

    const none = fakeCapacity([row()])
    await prepare(none.capacity, { launchPreferences: undefined })
    expect(none.capacity.refresh).not.toHaveBeenCalled()
  })

  it('refuses a workspace the runtime runs in WSL before reading capacity, and again at the fence', async () => {
    const { capacity } = fakeCapacity([row()])
    const windows = workspace({ path: 'C:\\code\\app' })
    let wsl = true
    const runsInWsl = vi.fn(() => wsl)
    const launch = () =>
      prepareAgentSessionLocalAccount({
        request: request(),
        workspace: windows,
        currentWorkspace: () => windows,
        runsInWsl,
        capacity
      })
    await expect(launch()).rejects.toMatchObject({
      code: 'agent_session_account_unverified',
      message: WSL_ACCOUNT_REFUSAL
    })
    expect(runsInWsl).toHaveBeenCalledWith(windows)
    expect(capacity.resolve).not.toHaveBeenCalled()
    wsl = false
    const prepared = await launch()
    wsl = true
    expect(() => prepared?.assertCurrent()).toThrow(WSL_ACCOUNT_REFUSAL)
    await expect(
      previewLocalLaunchAccount({
        agent: 'claude',
        model: 'opus',
        path: windows.path,
        runsInWsl: true,
        capacity
      })
    ).resolves.toEqual({ verified: false, refusal: WSL_ACCOUNT_REFUSAL, accounts: [] })
  })
})
