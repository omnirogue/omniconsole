import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { AccountCapacityReadings } from './account-capacity-readings'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'

describe('capacity reading persistence', () => {
  it('preserves last-known windows and Retry-After across restart without credential metadata', () => {
    const directory = mkdtempSync(join(tmpdir(), 'capacity-readings-'))
    try {
      const path = join(directory, 'readings.json')
      const cache = new AccountCapacityReadings(path)
      const key = JSON.stringify(['claude', '/synthetic/seat'])
      const reading: ProviderRateLimits = {
        provider: 'claude',
        session: { usedPercent: 75, windowMinutes: 300, resetsAt: 1000, resetDescription: null },
        weekly: null,
        status: 'ok',
        error: null,
        updatedAt: 100
      }
      cache.set(key, reading)
      cache.set(key, {
        ...reading,
        session: null,
        status: 'error',
        updatedAt: 200,
        usageMetadata: {
          failureKind: 'rate-limited',
          retryAtMs: 10000,
          credentialSource: 'must-not-persist'
        }
      })
      cache.flush()
      const restored = new AccountCapacityReadings(path).get(key)
      expect(restored?.session?.usedPercent).toBe(75)
      expect(restored?.updatedAt).toBe(100)
      expect(restored?.usageMetadata?.retryAtMs).toBe(10000)
      expect(readFileSync(path, 'utf8')).not.toContain('must-not-persist')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

it('persists normalized auth failures and preserves them when no read occurs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'capacity-auth-'))
  try {
    const path = join(directory, 'readings.json')
    const cache = new AccountCapacityReadings(path)
    const failure: ProviderRateLimits = {
      provider: 'codex',
      status: 'error',
      error: 'Sign in with ChatGPT',
      session: null,
      weekly: null,
      updatedAt: 0
    }
    cache.set('account', failure)
    cache.flush()
    const restored = new AccountCapacityReadings(path)
    expect(restored.get('account')?.error).toBe('auth')
    expect(restored.set('account', { ...failure, status: 'unavailable', error: null }).error).toBe(
      'auth'
    )
    restored.delete('account')
    expect(new AccountCapacityReadings(path).get('account')).toBeNull()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
