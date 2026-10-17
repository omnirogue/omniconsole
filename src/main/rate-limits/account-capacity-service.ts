import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import { clearSignedInCapacityReadings } from './account-capacity-sign-in'
import {
  normalizeClaudeConfigDir,
  isSameUsageWindow,
  LIVE_CLAUDE_INGEST_DEDUPE_MS
} from './claude-live-usage'
import { join } from 'node:path'
import type {
  CapacityProvider,
  ProviderAccountCapacitySnapshot
} from '../../shared/provider-account-capacity'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import type { ClaudeStatusLineRateLimits } from '../../shared/claude-statusline-rate-limits'
import { buildProviderAccountCapacity } from '../../shared/provider-account-capacity-builder'
import {
  fetchClaudeCapacityEntry,
  emptyReading,
  type CapacityEntry as Entry
} from './claude-capacity-reading'
import { resolveCapacityRoster, type CapacityRoster } from './account-capacity-roster'
import { systemClaudeConfigDir } from './claude-seat-directory'
import { fetchCodexCapacityEntry } from './codex-capacity-reading'
import { mapClaudeUsageWindow } from './claude-usage-window'
import { AccountCapacityReadings } from './account-capacity-readings'
export class AccountCapacityService {
  private entries: Record<CapacityProvider, Entry[]> = { claude: [], codex: [] }
  private readings: AccountCapacityReadings
  private exitTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private codexPtyHomes = new Map<string, string>()
  private resolving: Promise<void> | null = null
  private pending = new Map<string, Promise<ProviderRateLimits>>()
  private attempted = new Map<string, number>()
  constructor(
    private readonly roster: () => CapacityRoster,
    userData: string,
    private readonly changed: () => void
  ) {
    this.readings = new AccountCapacityReadings(
      join(userData, 'provider-account-capacity-readings.json')
    )
  }
  snapshot(): ProviderAccountCapacitySnapshot {
    const roster = this.roster()
    const rows = (provider: CapacityProvider) => {
      const accounts =
        provider === 'claude'
          ? roster.claudeManagedAccounts.filter((a) => a.managedAuthRuntime !== 'wsl')
          : roster.codexManagedAccounts.filter((a) => a.managedHomeRuntime !== 'wsl')
      return [
        ...accounts.map(
          (account) =>
            this.entries[provider].find((entry) => entry.accountId === account.id) ?? {
              accountId: account.id,
              email: account.email,
              launchEnv: null,
              checking: true
            }
        ),
        this.entries[provider].find((entry) => entry.accountId === null) ?? {
          accountId: null,
          email: null,
          launchEnv: null,
          checking: true
        }
      ]
    }
    return {
      claude: buildProviderAccountCapacity(
        'claude',
        rows('claude'),
        roster.activeClaudeManagedAccountId
      ),
      codex: buildProviderAccountCapacity(
        'codex',
        rows('codex'),
        roster.activeCodexManagedAccountId
      ),
      builtAt: Date.now()
    }
  }
  private resolvedAt = 0
  private resolvedRoster = ''
  resolve(force = false): Promise<void> {
    if (this.resolving) {
      return force ? this.resolving.then(() => this.resolve(true)) : this.resolving
    }
    const roster = JSON.stringify(this.roster())
    if (!force && roster === this.resolvedRoster && Date.now() - this.resolvedAt < 300_000) {
      return Promise.resolve()
    }
    this.resolving = this.resolveEntries()
      .then(() => {
        this.resolvedRoster = roster
        this.resolvedAt = Date.now()
      })
      .finally(() => {
        this.resolving = null
      })
    return this.resolving
  }
  private async resolveEntries(): Promise<void> {
    this.entries = await resolveCapacityRoster(this.roster(), this.readings)
    this.changed()
  }
  private key(provider: CapacityProvider, path: string): string {
    return JSON.stringify([provider, path])
  }
  async refresh(
    provider: CapacityProvider,
    accountId?: string | null,
    options: { force?: boolean } = {}
  ): Promise<ProviderRateLimits> {
    await this.resolve()
    const entries = this.entries[provider].filter(
      (entry) => accountId === undefined || entry.accountId === accountId
    )
    const unique = [...new Map(entries.map((entry) => [entry.path, entry])).values()]
    const results = await mapWithConcurrency(unique, 4, (entry) =>
      this.refreshEntry(provider, entry, options.force)
    )
    return results.at(-1) ?? emptyReading(provider)
  }

  async signedIn(provider: CapacityProvider, accountId?: string): Promise<void> {
    await Promise.allSettled(this.pending.values())
    const previous = this.entries[provider]
    await this.resolve(true)
    const ids = clearSignedInCapacityReadings(
      provider,
      accountId,
      previous,
      this.entries[provider],
      this.readings,
      this.attempted
    )
    for (const id of ids) {
      await this.refresh(provider, id, { force: true })
    }
  }
  async refreshAll(): Promise<void> {
    await this.resolve(true)
    await Promise.allSettled([
      this.refresh('claude', undefined, { force: true }),
      this.refresh('codex', undefined, { force: true })
    ])
  }
  async activeAfterReset(): Promise<ProviderRateLimits> {
    await Promise.allSettled(this.pending.values())
    return this.refresh('codex', this.roster().activeCodexManagedAccountId, { force: true })
  }
  active(provider: CapacityProvider): Promise<ProviderRateLimits> {
    const roster = this.roster()
    return this.refresh(
      provider,
      provider === 'claude'
        ? roster.activeClaudeManagedAccountId
        : roster.activeCodexManagedAccountId
    )
  }
  private refreshEntry(
    provider: CapacityProvider,
    entry: Entry,
    force = false
  ): Promise<ProviderRateLimits> {
    const key = this.key(provider, entry.path)
    const pending = this.pending.get(key)
    if (pending) {
      return pending
    }
    const cached = this.readings.get(key)
    if (
      !entry.launchEnv ||
      (cached?.usageMetadata?.retryAtMs ?? 0) > Date.now() ||
      (!force &&
        Date.now() - Math.max(this.attempted.get(key) ?? 0, cached?.updatedAt ?? 0) < 300_000)
    ) {
      return Promise.resolve(cached ?? emptyReading(provider))
    }
    this.attempted.set(key, Date.now())
    const operation = this.fetchEntry(provider, entry).finally(() => this.pending.delete(key))
    this.pending.set(key, operation)
    return operation
  }
  private async fetchEntry(provider: CapacityProvider, entry: Entry): Promise<ProviderRateLimits> {
    const originalPath = entry.path
    let fresh: ProviderRateLimits
    try {
      fresh =
        provider === 'claude'
          ? await fetchClaudeCapacityEntry(entry, this.readings)
          : await fetchCodexCapacityEntry(entry.path)
    } catch {
      fresh = {
        ...emptyReading(provider),
        status: 'error',
        usageMetadata: { failureKind: 'network' }
      }
    }
    entry.reading = this.readings.set(this.key(provider, entry.path), fresh)
    for (const current of this.entries[provider]) {
      if (current.accountId === entry.accountId && current.path === originalPath) {
        current.reading = entry.reading
        current.launchEnv = entry.launchEnv
      } else if (current.path === entry.path) {
        current.reading = entry.reading
      }
    }
    this.changed()
    return entry.reading
  }
  recordCodexPty(id: string, path: string): void {
    this.codexPtyHomes.set(id, path)
  }
  codexPtyExited(id: string): void {
    const path = this.codexPtyHomes.get(id)
    this.codexPtyHomes.delete(id)
    if (path) {
      this.scheduleExitRefresh('codex', path)
    }
  }
  scheduleExitRefresh(provider: CapacityProvider, path: string): void {
    const key = this.key(provider, path)
    const previous = this.exitTimers.get(key)
    if (previous) {
      clearTimeout(previous)
    }
    const timer = setTimeout(() => {
      this.exitTimers.delete(key)
      const entry = this.entries[provider].find((item) => item.path === path)
      if (entry) {
        this.attempted.delete(key)
        if ((this.readings.get(key)?.usageMetadata?.retryAtMs ?? 0) <= Date.now()) {
          void this.refreshEntry(provider, entry)
        }
      }
    }, 1500)
    timer.unref()
    this.exitTimers.set(key, timer)
  }
  legacy(provider: CapacityProvider) {
    return this.entries[provider]
      .filter(
        (entry) =>
          entry.accountId !== null &&
          entry.accountId !==
            (provider === 'claude'
              ? this.roster().activeClaudeManagedAccountId
              : this.roster().activeCodexManagedAccountId)
      )
      .map((entry) => ({
        accountId: entry.accountId!,
        rateLimits: entry.reading ?? null,
        updatedAt: entry.reading?.updatedAt ?? 0,
        isFetching: this.pending.has(this.key(provider, entry.path))
      }))
  }
  ingest(event: ClaudeStatusLineRateLimits): ProviderRateLimits | null {
    const path = normalizeClaudeConfigDir(event.configDir ?? systemClaudeConfigDir())!
    const matching = this.entries.claude.filter(
      (entry) => normalizeClaudeConfigDir(entry.path) === path
    )
    const key = this.key('claude', matching[0]?.path ?? path)
    const previous = this.readings.get(key)
    const session = mapClaudeUsageWindow(event.fiveHour ?? undefined, 300)
    const weekly = mapClaudeUsageWindow(event.sevenDay ?? undefined, 10080)
    if (
      (!session && !weekly) ||
      (previous?.usageMetadata?.source === 'live-session' &&
        Date.now() - previous.updatedAt < LIVE_CLAUDE_INGEST_DEDUPE_MS &&
        isSameUsageWindow(previous.session, session ?? previous.session) &&
        isSameUsageWindow(previous.weekly, weekly ?? previous.weekly))
    ) {
      return null
    }
    const reading = this.readings.set(key, {
      provider: 'claude',
      session: session ?? previous?.session ?? null,
      weekly: weekly ?? previous?.weekly ?? null,
      fableWeekly: previous?.fableWeekly,
      updatedAt: Date.now(),
      status: 'ok',
      error: null,
      usageMetadata: { source: 'live-session', retryAtMs: previous?.usageMetadata?.retryAtMs }
    })
    for (const entry of matching) {
      entry.reading = reading
    }
    this.changed()
    return matching.some((entry) => entry.accountId === this.roster().activeClaudeManagedAccountId)
      ? reading
      : null
  }
}
