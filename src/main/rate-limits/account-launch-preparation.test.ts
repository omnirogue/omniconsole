import { systemClaudeConfigDir } from './claude-seat-directory'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { RateLimitService } from './service'
import { prepareClaudeAccountSession } from '../claude-accounts/account-session-auth'
import { chooseAccountForLaunch } from '../../shared/account-launch-selection'
import type * as AccountLaunchSelection from '../../shared/account-launch-selection'
import {
  chooseBalancedCodexAccount,
  prepareBalancedClaudeAccount
} from './account-launch-preparation'

vi.mock('../claude-accounts/account-session-auth', () => ({ prepareClaudeAccountSession: vi.fn() }))
vi.mock('../claude-accounts/account-directory-hooks', () => ({
  ensureClaudeHooksForRequestedEnv: vi.fn()
}))
vi.mock('../../shared/account-launch-selection', async (importOriginal) => {
  const actual = await importOriginal<typeof AccountLaunchSelection>()
  return { ...actual, chooseAccountForLaunch: vi.fn(actual.chooseAccountForLaunch) }
})

const target = { runtime: 'host' as const, wslDistro: null }
const usage = (provider: string, used: number) => ({
  provider,
  status: 'ok',
  updatedAt: Date.now(),
  session: {
    usedPercent: used,
    windowMinutes: 300,
    resetsAt: Date.now() + 600_000
  },
  weekly: null
})
function context() {
  const settings = {
    activeClaudeManagedAccountId: 'claude-default',
    activeCodexManagedAccountId: 'codex-default',
    claudeManagedAccounts: [
      { id: 'claude-default', managedAuthPath: '/a' },
      { id: 'claude-spare', managedAuthPath: '/b' }
    ],
    codexManagedAccounts: [
      { id: 'codex-default', managedHomePath: '/c' },
      { id: 'codex-spare', managedHomePath: '/d' }
    ]
  }
  const updateSettings = vi.fn()
  const store = { getSettings: () => settings, updateSettings } as unknown as Store
  const fetchInactiveClaudeAccountsOnOpen = vi.fn().mockResolvedValue(undefined)
  const fetchInactiveCodexAccountsOnOpen = vi.fn().mockResolvedValue(undefined)
  const rateLimits = {
    fetchInactiveClaudeAccountsOnOpen,
    fetchInactiveCodexAccountsOnOpen,
    getState: () => ({
      claude: usage('claude', 80),
      codex: usage('codex', 70),
      claudeTarget: target,
      codexTarget: target,
      inactiveClaudeAccounts: [{ accountId: 'claude-spare', rateLimits: usage('claude', 15) }],
      inactiveCodexAccounts: [{ accountId: 'codex-spare', rateLimits: usage('codex', 25) }]
    })
  } as unknown as RateLimitService
  const fallback = vi.fn().mockResolvedValue({ configDir: '/system' })
  return { store, rateLimits, target, fallback, updateSettings }
}

describe('balance-aware launch preparation', () => {
  it('passes the recorded transcript for safe seat routing regardless of default and balance', async () => {
    const args = context()
    await prepareBalancedClaudeAccount({
      ...args,
      options: {
        preserveAccount: true,
        resumeSession: {
          key: 'session_id',
          id: 'old-session',
          transcriptPath: '/a/session/projects/project/old-session.jsonl'
        }
      }
    })
    expect(prepareClaudeAccountSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'claude-default' }),
      {
        preserveSessionDirectory: true,
        transcriptPath: '/a/session/projects/project/old-session.jsonl'
      }
    )
    expect(args.fallback).not.toHaveBeenCalled()
    expect(args.rateLimits.fetchInactiveClaudeAccountsOnOpen).not.toHaveBeenCalled()
  })
  it('uses legacy System preparation without introducing CLAUDE_CONFIG_DIR', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '')
    try {
      const args = context()
      await prepareBalancedClaudeAccount({
        ...args,
        options: { env: { CLAUDE_CONFIG_DIR: systemClaudeConfigDir() } }
      })
      expect(args.fallback).toHaveBeenCalledOnce()
      expect(prepareClaudeAccountSession).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })
  it('keeps WSL preparation on its existing runtime', async () => {
    const args = context()
    await prepareBalancedClaudeAccount({ ...args, target: { runtime: 'wsl', wslDistro: 'Ubuntu' } })
    expect(args.fallback).toHaveBeenCalledOnce()
    expect(prepareClaudeAccountSession).not.toHaveBeenCalled()
  })

  beforeEach(() => vi.clearAllMocks())
  it('prepares the highest Claude balance without changing the saved default', async () => {
    const args = context()
    await prepareBalancedClaudeAccount(args)
    expect(prepareClaudeAccountSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'claude-spare' })
    )
    expect(args.updateSettings).not.toHaveBeenCalled()
    expect(args.fallback).not.toHaveBeenCalled()
  })
  it.each(['claude', 'codex'] as const)(
    'does not wait for %s capacity refresh',
    async (provider) => {
      const args = context()
      const refresh =
        provider === 'claude'
          ? args.rateLimits.fetchInactiveClaudeAccountsOnOpen
          : args.rateLimits.fetchInactiveCodexAccountsOnOpen
      vi.mocked(refresh).mockReturnValue(new Promise(() => {}))
      const launch =
        provider === 'claude'
          ? prepareBalancedClaudeAccount(args)
          : chooseBalancedCodexAccount(args)
      await launch
      expect(refresh).toHaveBeenCalledOnce()
      expect(args.updateSettings).not.toHaveBeenCalled()
    }
  )
  it('contains a background capacity failure', async () => {
    const args = context()
    vi.mocked(args.rateLimits.fetchInactiveClaudeAccountsOnOpen).mockRejectedValue(
      new Error('offline')
    )
    await prepareBalancedClaudeAccount(args)
    expect(prepareClaudeAccountSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'claude-spare' })
    )
  })
  it('keeps an explicit managed account even when another has more balance', async () => {
    const args = context()
    await prepareBalancedClaudeAccount({
      ...args,
      options: { env: { CLAUDE_CONFIG_DIR: '/a/session' } }
    })
    expect(prepareClaudeAccountSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'claude-default' }),
      { preserveSessionDirectory: undefined, transcriptPath: undefined }
    )
    expect(args.rateLimits.fetchInactiveClaudeAccountsOnOpen).not.toHaveBeenCalled()
  })
  it('preserves external profiles and does not touch account credentials during resume', async () => {
    const args = context()
    expect(
      await prepareBalancedClaudeAccount({
        ...args,
        options: { env: { CLAUDE_CONFIG_DIR: '/external' } }
      })
    ).toMatchObject({ configDir: '/external' })
    await prepareBalancedClaudeAccount({ ...args, options: { preserveAccount: true } })
    expect(args.fallback).toHaveBeenCalledOnce()
    expect(prepareClaudeAccountSession).not.toHaveBeenCalled()
    expect(args.rateLimits.fetchInactiveClaudeAccountsOnOpen).not.toHaveBeenCalled()
  })
  it('selects the highest Codex balance without mutating global selection', async () => {
    const args = context()
    expect(await chooseBalancedCodexAccount(args)).toBe('codex-spare')
    expect(args.updateSettings).not.toHaveBeenCalled()
  })
  it('pins an arbitrary transcript profile ahead of the currently selected profile', async () => {
    const args = context()
    const result = await prepareBalancedClaudeAccount({
      ...args,
      options: {
        env: { CLAUDE_CONFIG_DIR: '/wrong' },
        preserveAccount: true,
        resumeSession: {
          key: 'session_id',
          id: 'real',
          transcriptPath: '/profiles/claude-account-5/projects/-repo/real.jsonl'
        }
      }
    })
    expect(result.envPatch).toEqual({ CLAUDE_CONFIG_DIR: '/profiles/claude-account-5' })
    expect(args.fallback).not.toHaveBeenCalled()
    expect(args.rateLimits.fetchInactiveClaudeAccountsOnOpen).not.toHaveBeenCalled()
  })
})

// Why: a host-side best-verified pick is only real if spawn preflight never re-balances it.
describe('pin integrity for host-selected launch accounts', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each([
    ['managed', '/a/session'],
    ['seat', '/home/me/.claude-account-5'],
    ['pool', '/home/me/.claude-accounts/pool/slot-3']
  ])('an explicit %s CLAUDE_CONFIG_DIR never calls chooseAccountForLaunch', async (_kind, dir) => {
    const args = context()
    await prepareBalancedClaudeAccount({ ...args, options: { env: { CLAUDE_CONFIG_DIR: dir } } })
    expect(chooseAccountForLaunch).not.toHaveBeenCalled()
    expect(args.rateLimits.fetchInactiveClaudeAccountsOnOpen).not.toHaveBeenCalled()
    expect(args.fallback).not.toHaveBeenCalled()
  })

  it('the system dir with no managed default prepares the system login', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '')
    try {
      const args = context()
      Object.assign(args.store.getSettings(), { activeClaudeManagedAccountId: null })
      await prepareBalancedClaudeAccount({
        ...args,
        options: { env: { CLAUDE_CONFIG_DIR: systemClaudeConfigDir() } }
      })
      expect(args.fallback).toHaveBeenCalledOnce()
      expect(chooseAccountForLaunch).not.toHaveBeenCalled()
      expect(prepareClaudeAccountSession).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('an empty CLAUDE_CONFIG_DIR re-balances', async () => {
    const args = context()
    await prepareBalancedClaudeAccount({ ...args, options: { env: { CLAUDE_CONFIG_DIR: '' } } })
    expect(chooseAccountForLaunch).toHaveBeenCalledOnce()
    expect(prepareClaudeAccountSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'claude-spare' })
    )
  })
})
