import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderAccountDiscovery } from './provider-account-discovery'
import type { ExistingAccountDirectory } from './existing-account-directories'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture(profiles: ExistingAccountDirectory[]) {
  const home = mkdtempSync(join(tmpdir(), 'provider-discovery-'))
  roots.push(home)
  const accounts: {
    id: string
    email: string
    providerAccountId?: string | null
    workspaceAccountId?: string | null
    organizationUuid?: string | null
    managedHomeRuntime?: 'host' | 'wsl'
    managedAuthRuntime?: 'host' | 'wsl'
    wslDistro?: string | null
  }[] = []
  const listAccounts = () => ({ accounts, activeAccountId: null })
  const add = vi.fn(
    async (path: string, target: { runtime: 'host' | 'wsl'; wslDistro?: string | null }) => {
      const profile = profiles.find((p) => p.path === path)!
      accounts.push({
        ...profile,
        id: String(accounts.length),
        email: profile.email!,
        managedHomeRuntime: target.runtime,
        wslDistro: target.wslDistro
      })
      return listAccounts()
    }
  )
  const dependencies = {
    home,
    statePath: join(home, 'discovery.json'),
    claude: { listAccounts, addAccountFromConfigDir: add },
    codex: { listAccounts, addAccountFromHome: add },
    discover: () => profiles,
    hasCredentials: vi.fn(async () => true),
    additionalHomes: async () => [] as string[]
  }
  return { accounts, add, dependencies, service: new ProviderAccountDiscovery(dependencies) }
}

describe('automatic provider account discovery', () => {
  it('registers each signed-in identity once and preserves the selected Codex account', async () => {
    const f = fixture([
      { provider: 'codex', path: '/profile', email: 'me@example.com' },
      { provider: 'codex', path: '/alias', email: 'me@example.com' }
    ])
    await f.service.refresh()
    await f.service.refresh()
    expect(f.add).toHaveBeenCalledExactlyOnceWith('/profile', {
      runtime: 'host',
      preserveSelection: true
    })
  })
  it('retains distinct workspaces for the same email without importing their aliases twice', async () => {
    const f = fixture([
      {
        provider: 'codex',
        path: '/one',
        email: 'me@example.com',
        providerAccountId: 'person',
        workspaceAccountId: 'one'
      },
      {
        provider: 'codex',
        path: '/two',
        email: 'me@example.com',
        providerAccountId: 'person',
        workspaceAccountId: 'two'
      },
      {
        provider: 'codex',
        path: '/duplicate',
        email: 'me@example.com',
        providerAccountId: 'person',
        workspaceAccountId: 'one'
      }
    ])
    await f.service.refresh()
    await f.service.refresh()
    expect(f.add).toHaveBeenCalledTimes(2)
    expect(f.accounts.map((account) => account.workspaceAccountId)).toEqual(['one', 'two'])
  })
  it('discovers running WSL homes separately from Windows and other distributions', async () => {
    const profiles: ExistingAccountDirectory[] = [
      { provider: 'codex', path: '/native', email: 'me@example.com' },
      {
        provider: 'codex',
        path: '/ubuntu',
        email: 'me@example.com',
        runtime: 'wsl',
        wslDistro: 'Ubuntu'
      },
      {
        provider: 'codex',
        path: '/debian',
        email: 'me@example.com',
        runtime: 'wsl',
        wslDistro: 'Debian'
      }
    ]
    const f = fixture(profiles)
    f.dependencies.discover = (home?: string) =>
      home === '/wsl' ? profiles.slice(1) : profiles.slice(0, 1)
    f.dependencies.additionalHomes = async () => ['/wsl']
    await f.service.refresh()
    await f.service.refresh()
    expect(f.add).toHaveBeenCalledTimes(3)
    expect(f.add).toHaveBeenCalledWith('/ubuntu', {
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      preserveSelection: true
    })
    expect(f.add).toHaveBeenCalledWith('/debian', {
      runtime: 'wsl',
      wslDistro: 'Debian',
      preserveSelection: true
    })
  })
  it('discovers a login after empty credentials are replaced', async () => {
    const f = fixture([{ provider: 'claude', path: '/profile', email: 'me@example.com' }])
    f.dependencies.hasCredentials.mockResolvedValueOnce(false)
    await f.service.refresh()
    expect(f.add).not.toHaveBeenCalled()
    await f.service.refresh()
    expect(f.add).toHaveBeenCalledOnce()
  })
  it('keeps a removed account removed across restarts', async () => {
    const f = fixture([{ provider: 'claude', path: '/profile', email: 'me@example.com' }])
    await f.service.refresh()
    f.accounts.splice(0)
    const restarted = new ProviderAccountDiscovery(f.dependencies)
    await restarted.refresh()
    expect(f.add).toHaveBeenCalledOnce()
    expect(f.accounts).toHaveLength(0)
  })
  it('coalesces concurrent scans and continues after an inaccessible profile', async () => {
    const f = fixture([
      { provider: 'claude', path: '/locked', email: 'locked@example.com' },
      { provider: 'claude', path: '/ready', email: 'ready@example.com' }
    ])
    f.dependencies.hasCredentials.mockRejectedValueOnce(new Error('Keychain locked'))
    const first = f.service.refresh()
    expect(f.service.refresh()).toBe(first)
    await first
    expect(f.add).toHaveBeenCalledExactlyOnceWith('/ready', { runtime: 'host' })
  })
})
