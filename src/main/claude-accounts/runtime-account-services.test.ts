import { describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'

const built = vi.hoisted(() => {
  const order: string[] = []
  const construct = (name: string) =>
    vi.fn(function (this: Record<string, unknown>, ...args: unknown[]) {
      order.push(name)
      this.name = name
      this.args = args
    })
  return {
    order,
    RateLimitService: construct('rateLimits'),
    CodexRuntimeHomeService: construct('codexRuntimeHome'),
    CodexAccountService: construct('codexAccounts'),
    ClaudeRuntimeAuthService: construct('claudeRuntimeAuth'),
    ClaudeAccountService: construct('claudeAccounts'),
    AccountCapacityService: construct('accountCapacity'),
    ProviderAccountDiscovery: construct('discovery')
  }
})

vi.mock('../rate-limits/service', () => {
  built.RateLimitService.prototype.setCodexHomePathResolver = vi.fn()
  built.RateLimitService.prototype.setCodexFetchTarget = vi.fn()
  built.RateLimitService.prototype.setClaudeFetchTarget = vi.fn()
  built.RateLimitService.prototype.setClaudeAuthPreparationResolver = vi.fn()
  built.RateLimitService.prototype.pushAccountCapacity = vi.fn()
  built.RateLimitService.prototype.refreshDiscoveredAccountsUsage = vi.fn(async () => {})
  return { RateLimitService: built.RateLimitService }
})
vi.mock('../codex-accounts/runtime-home-service', () => {
  built.CodexRuntimeHomeService.prototype.prepareForRateLimitFetch = vi.fn(() => 'codex-home')
  return { CodexRuntimeHomeService: built.CodexRuntimeHomeService }
})
vi.mock('../codex-accounts/service', () => ({ CodexAccountService: built.CodexAccountService }))
vi.mock('./runtime-auth-service', () => {
  built.ClaudeRuntimeAuthService.prototype.prepareForRateLimitFetch = vi.fn(
    async () => 'claude-auth'
  )
  return { ClaudeRuntimeAuthService: built.ClaudeRuntimeAuthService }
})
vi.mock('./service', () => ({ ClaudeAccountService: built.ClaudeAccountService }))
vi.mock('../rate-limits/account-capacity-service', () => ({
  AccountCapacityService: built.AccountCapacityService
}))
vi.mock('../rate-limits/provider-account-discovery', () => {
  built.ProviderAccountDiscovery.prototype.start = vi.fn()
  built.ProviderAccountDiscovery.prototype.stop = vi.fn()
  return { ProviderAccountDiscovery: built.ProviderAccountDiscovery }
})
vi.mock('../rate-limits/claude-rate-limit-target', () => ({
  getInitialClaudeRateLimitTarget: (settings: { tag: string }) => ({ claudeFor: settings.tag })
}))
vi.mock('../rate-limits/codex-rate-limit-target', () => ({
  getInitialCodexRateLimitTarget: (settings: { tag: string }) => ({ codexFor: settings.tag })
}))
vi.mock('./runtime-selection', () => ({
  normalizeClaudeRuntimeSelection: () => ({ host: 'claude-active', wsl: {} })
}))
vi.mock('../codex-accounts/runtime-selection', () => ({
  normalizeCodexRuntimeSelection: () => ({ host: 'codex-active', wsl: {} })
}))

import { createRuntimeAccountServices } from './runtime-account-services'

const settings = { tag: 'settings', claudeManagedAccounts: [] }
const store = { getSettings: () => settings } as unknown as Store

describe('the runtime account services', () => {
  it('are built in the desktop order, with the Codex hook between the runtime home and its service', () => {
    built.order.splice(0)
    const requestRun = vi.fn()
    const configureCodexRuntimeHome = vi.fn((runtimeHome: unknown) => {
      expect(built.order).toEqual(['rateLimits', 'codexRuntimeHome'])
      expect(runtimeHome).toBeInstanceOf(built.CodexRuntimeHomeService)
      return { onHostSystemDefaultSelected: requestRun }
    })
    const bundle = createRuntimeAccountServices({
      store,
      home: '/Users/maintainer',
      userDataPath: '/Users/maintainer/Library/OmniConsole',
      configureCodexRuntimeHome
    })
    expect(configureCodexRuntimeHome).toHaveBeenCalledTimes(1)
    expect(built.order).toEqual([
      'rateLimits',
      'codexRuntimeHome',
      'codexAccounts',
      'claudeRuntimeAuth',
      'claudeAccounts',
      'accountCapacity',
      'discovery'
    ])
    expect(built.CodexAccountService).toHaveBeenLastCalledWith(
      store,
      bundle.rateLimits,
      bundle.codexRuntimeHome,
      { onHostSystemDefaultSelected: requestRun }
    )
    expect(built.ClaudeRuntimeAuthService).toHaveBeenLastCalledWith(store)
    expect(built.ClaudeAccountService).toHaveBeenLastCalledWith(
      store,
      bundle.rateLimits,
      bundle.claudeRuntimeAuth
    )
    expect(bundle.services).toEqual({
      claudeAccounts: bundle.claudeAccounts,
      codexAccounts: bundle.codexAccounts,
      rateLimits: bundle.rateLimits,
      discovery: bundle.discovery
    })
  })

  it('wires usage fetching to the homes and settings, and discovery to the account services', async () => {
    const bundle = createRuntimeAccountServices({
      store,
      home: '/home/worker',
      userDataPath: '/home/worker/.config/OmniConsole'
    })
    // Without the desktop hook the Codex service gets an empty lifecycle.
    expect(built.CodexAccountService.mock.lastCall?.[3]).toEqual({})
    const rateLimits = bundle.rateLimits as unknown as Record<string, ReturnType<typeof vi.fn>>
    expect(rateLimits.setCodexFetchTarget).toHaveBeenCalledWith({ codexFor: 'settings' })
    expect(rateLimits.setClaudeFetchTarget).toHaveBeenCalledWith({ claudeFor: 'settings' })
    const codexHome = rateLimits.setCodexHomePathResolver!.mock.lastCall![0] as (
      t: unknown
    ) => unknown
    expect(codexHome('host')).toBe('codex-home')
    expect(bundle.codexRuntimeHome.prepareForRateLimitFetch).toHaveBeenCalledWith('host')
    const claudeAuth = rateLimits.setClaudeAuthPreparationResolver!.mock.lastCall![0] as (
      t: unknown
    ) => Promise<unknown>
    await expect(claudeAuth('wsl')).resolves.toBe('claude-auth')
    // The capacity roster reads the store and the active selections.
    const [roster, userData, changed] = built.AccountCapacityService.mock.lastCall as [
      () => Record<string, unknown>,
      string,
      () => void
    ]
    expect(roster()).toMatchObject({
      tag: 'settings',
      activeClaudeManagedAccountId: 'claude-active',
      activeCodexManagedAccountId: 'codex-active'
    })
    expect(userData).toBe('/home/worker/.config/OmniConsole')
    changed()
    expect(rateLimits.pushAccountCapacity).toHaveBeenCalled()
    expect(bundle.rateLimits.accountCapacity).toBeInstanceOf(built.AccountCapacityService)
    // Discovery scans the home, keeps its receipt under userData, and refreshes usage on a change.
    const [discovery] = built.ProviderAccountDiscovery.mock.lastCall as [
      { home: string; statePath: string; claude: unknown; codex: unknown; onChanged: () => void }
    ]
    expect(discovery).toMatchObject({
      home: '/home/worker',
      statePath: '/home/worker/.config/OmniConsole/provider-account-discovery.json',
      claude: bundle.claudeAccounts,
      codex: bundle.codexAccounts
    })
    discovery.onChanged()
    expect(rateLimits.refreshDiscoveredAccountsUsage).toHaveBeenCalled()
    bundle.start()
    bundle.stop()
    expect(bundle.discovery.start).toHaveBeenCalledTimes(1)
    expect(bundle.discovery.stop).toHaveBeenCalledTimes(1)
  })
})
