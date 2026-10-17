import { listRunningWslHomeDirsAsync } from '../wsl'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { persistClaudeSeatDirectories } from './claude-seat-directory'
import {
  discoverExistingAccountDirectories,
  type ExistingAccountDirectory
} from './existing-account-directories'
import { hasDiscoveredProfileCredentials } from './discovered-profile-credentials'

type Account = {
  id: string
  email: string
  providerAccountId?: string | null
  workspaceAccountId?: string | null
  organizationUuid?: string | null
  managedAuthRuntime?: 'host' | 'wsl'
  managedHomeRuntime?: 'host' | 'wsl'
  wslDistro?: string | null
}
type DiscoveryTarget = { runtime: 'host' | 'wsl'; wslDistro?: string | null }
type AccountState = { accounts: Account[] }
type Dependencies = {
  home: string
  statePath: string
  claude: {
    listAccounts(): AccountState
    addAccountFromConfigDir(path: string, target: DiscoveryTarget): Promise<AccountState>
  }
  codex: {
    listAccounts(): AccountState
    addAccountFromHome(
      path: string,
      target: DiscoveryTarget & { preserveSelection: true }
    ): Promise<AccountState>
  }
  discover?: typeof discoverExistingAccountDirectories
  hasCredentials?: typeof hasDiscoveredProfileCredentials
  onChanged?: () => void
  additionalHomes?: () => Promise<string[]>
}

export class ProviderAccountDiscovery {
  private pending: Promise<void> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private known: Record<string, string> = {}

  constructor(private readonly dependencies: Dependencies) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(dependencies.statePath, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.known = Object.fromEntries(
          Object.entries(parsed).filter(([, value]) => typeof value === 'string')
        )
      }
    } catch {
      // First launch has no discovery receipt yet.
    }
  }

  start(): void {
    if (this.timer) {
      return
    }
    this.stopped = false
    void this.refresh().catch(() => {})
    this.timer = setInterval(() => {
      void this.refresh().catch(() => {})
    }, 60_000)
    this.timer.unref()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
    }
    this.timer = null
  }

  refresh(): Promise<void> {
    if (this.pending) {
      return this.pending
    }
    this.pending = this.scan().finally(() => {
      this.pending = null
    })
    return this.pending
  }

  private accounts(provider: 'claude' | 'codex') {
    const state =
      provider === 'claude'
        ? this.dependencies.claude.listAccounts()
        : this.dependencies.codex.listAccounts()
    return state.accounts
  }

  private key(
    profile: Omit<ExistingAccountDirectory, 'path'> &
      Pick<Account, 'managedAuthRuntime' | 'managedHomeRuntime'>
  ): string {
    const identity = [
      profile.provider,
      profile.email?.trim().toLowerCase(),
      profile.organizationUuid ?? null,
      profile.providerAccountId ?? null,
      profile.workspaceAccountId ?? null
    ]
    const runtime =
      profile.runtime ?? profile.managedAuthRuntime ?? profile.managedHomeRuntime ?? 'host'
    return JSON.stringify(runtime === 'wsl' ? [...identity, 'wsl', profile.wslDistro] : identity)
  }

  private async scan(): Promise<void> {
    let changed = false
    for (const provider of ['claude', 'codex'] as const) {
      for (const account of this.accounts(provider)) {
        this.known[this.key({ provider, ...account })] = account.id
      }
    }
    const profiles = [
      ...(this.dependencies.discover ?? discoverExistingAccountDirectories)(this.dependencies.home)
    ]
    if (process.platform === 'win32' || this.dependencies.additionalHomes) {
      const homes = await (
        this.dependencies.additionalHomes ?? listRunningWslHomeDirsAsync
      )().catch(() => [])
      for (const home of homes) {
        profiles.push(...(this.dependencies.discover ?? discoverExistingAccountDirectories)(home))
      }
    }
    mkdirSync(dirname(this.dependencies.statePath), { recursive: true })
    changed = persistClaudeSeatDirectories(
      join(dirname(this.dependencies.statePath), 'provider-account-seats.json'),
      profiles
    )
    for (const profile of profiles) {
      if (this.stopped) {
        break
      }
      if (!profile.email) {
        continue
      }
      const key = this.key(profile)
      // A missing previously registered account was removed by the user.
      if (this.known[key]) {
        continue
      }
      try {
        if (
          !(await (this.dependencies.hasCredentials ?? hasDiscoveredProfileCredentials)(profile))
        ) {
          continue
        }
        if (this.stopped) {
          break
        }
        const target: DiscoveryTarget =
          profile.runtime === 'wsl'
            ? { runtime: 'wsl', wslDistro: profile.wslDistro }
            : { runtime: 'host' }
        const state =
          profile.provider === 'claude'
            ? await this.dependencies.claude.addAccountFromConfigDir(profile.path, target)
            : await this.dependencies.codex.addAccountFromHome(profile.path, {
                ...target,
                preserveSelection: true
              })
        for (const account of state.accounts) {
          this.known[this.key({ provider: profile.provider, ...account })] = account.id
        }
        const registered = state.accounts.find(
          (account) =>
            (account.managedAuthRuntime ?? account.managedHomeRuntime ?? 'host') ===
              target.runtime &&
            (account.wslDistro ?? null) === (target.wslDistro ?? null) &&
            account.email.toLowerCase() === profile.email?.toLowerCase() &&
            (!profile.providerAccountId ||
              profile.providerAccountId === account.providerAccountId) &&
            (!profile.workspaceAccountId ||
              profile.workspaceAccountId === account.workspaceAccountId) &&
            (!profile.organizationUuid || profile.organizationUuid === account.organizationUuid)
        )
        if (registered) {
          this.known[key] = registered.id
        }
        changed = true
      } catch {
        // Locked credentials and expired profiles can be retried after sign-in.
      }
    }
    mkdirSync(dirname(this.dependencies.statePath), { recursive: true })
    const temporaryPath = `${this.dependencies.statePath}.tmp`
    writeFileSync(temporaryPath, JSON.stringify(this.known), { mode: 0o600 })
    renameSync(temporaryPath, this.dependencies.statePath)
    if (changed && !this.stopped) {
      this.dependencies.onChanged?.()
    }
  }
}
