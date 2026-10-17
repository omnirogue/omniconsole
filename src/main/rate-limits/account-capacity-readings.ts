import { isCodexAuthError } from '../../shared/codex-auth-errors'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'

export class AccountCapacityReadings {
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private readings = new Map<string, ProviderRateLimits>()
  constructor(private readonly path: string) {
    try {
      const saved = JSON.parse(readFileSync(path, 'utf8'))
      if (saved.version === 1 && Array.isArray(saved.readings)) {
        for (const [key, reading] of saved.readings) {
          if (
            typeof key === 'string' &&
            reading &&
            ['claude', 'codex'].includes(reading.provider) &&
            typeof reading.updatedAt === 'number'
          ) {
            this.readings.set(key, reading)
          }
        }
      }
    } catch {
      /* A first launch has no reading cache. */
    }
  }
  get(key: string): ProviderRateLimits | null {
    return this.readings.get(key) ?? null
  }
  delete(key: string): void {
    this.readings.delete(key)
    this.flush()
  }
  set(key: string, fresh: ProviderRateLimits): ProviderRateLimits {
    const previous = this.get(key)
    if (previous && fresh.status === 'unavailable' && fresh.updatedAt === 0) {
      return previous
    }
    const reading =
      fresh.status !== 'ok' && previous
        ? {
            ...fresh,
            session: previous.session,
            weekly: previous.weekly,
            fableWeekly: previous.fableWeekly,
            updatedAt: previous.updatedAt
          }
        : fresh
    this.readings.set(key, reading)
    if (!this.persistTimer) {
      this.persistTimer = setTimeout(() => this.flush(), 250)
      this.persistTimer.unref()
    }
    return reading
  }
  flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    // Why: persist only usage fields; credential provenance may contain sensitive implementation details.
    const readings = [...this.readings].map(([id, value]) => [
      id,
      {
        provider: value.provider,
        session: value.session,
        weekly: value.weekly,
        fableWeekly: value.fableWeekly,
        updatedAt: value.updatedAt,
        status: value.status,
        error:
          isCodexAuthError(value.error) ||
          /^(auth)$|token_revoked|token has been revoked/i.test(value.error ?? '')
            ? 'auth'
            : null,
        usageMetadata: {
          failureKind: value.usageMetadata?.failureKind,
          retryAtMs: value.usageMetadata?.retryAtMs
        }
      }
    ])
    try {
      writeFileSync(`${this.path}.tmp`, JSON.stringify({ version: 1, readings }), { mode: 0o600 })
      renameSync(`${this.path}.tmp`, this.path)
    } catch {
      /* Keep in-memory readings if the profile is temporarily read-only. */
    }
  }
}
