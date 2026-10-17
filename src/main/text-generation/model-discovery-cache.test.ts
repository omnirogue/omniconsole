import { chmodSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createModelDiscoveryCache,
  MODEL_DISCOVERY_CACHE_TTL_MS,
  MODEL_DISCOVERY_FAILURE_CACHE_TTL_MS,
  resolveModelDiscoveryBinaryFingerprint
} from './model-discovery-cache'
import type { DiscoverCommitMessageModelsResult } from './source-control-text-generation-types'
import { MODEL_LISTING_LIFETIME_MS } from '../../shared/model-listing-lifetime'

const listing = (id: string): DiscoverCommitMessageModelsResult => ({
  success: true,
  capability: {
    id: 'claude',
    label: 'Claude',
    modelSource: 'dynamic',
    defaultModelId: id,
    models: []
  },
  models: [{ id, label: id }],
  defaultModelId: id,
  catalogOrigin: 'probe'
})

let binDir: string
let env: NodeJS.ProcessEnv

function input(overrides: Partial<NodeJS.ProcessEnv> = {}) {
  return {
    agentId: 'claude',
    plan: { binary: 'fakecli', args: ['-p', '--verbose'], stdinPayload: '{}\n' },
    env: { ...env, ...overrides }
  }
}

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), 'model-discovery-cache-'))
  const binary = join(binDir, 'fakecli')
  writeFileSync(binary, '#!/bin/sh\nexit 0\n')
  chmodSync(binary, 0o755)
  env = { PATH: binDir, HOME: '/home/tester' }
})

afterEach(() => {
  rmSync(binDir, { recursive: true, force: true })
})

describe('model discovery cache', () => {
  it('reuses a listing for the same binary inside the lifetime, then lists again', async () => {
    let now = 1_000_000
    const cache = createModelDiscoveryCache({ now: () => now })
    const discover = vi.fn(async () => listing('opus'))

    await expect(cache.run(input(), discover)).resolves.toEqual(listing('opus'))
    now += MODEL_DISCOVERY_CACHE_TTL_MS - 1
    await cache.run(input(), discover)
    expect(discover).toHaveBeenCalledTimes(1)

    now += 1
    await cache.run(input(), discover)
    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('lists again as soon as the CLI binary changes (an update)', async () => {
    const cache = createModelDiscoveryCache()
    const discover = vi.fn(async () => listing('opus'))
    await cache.run(input(), discover)
    await cache.run(input(), discover)
    expect(discover).toHaveBeenCalledTimes(1)

    const updated = new Date(Date.now() + 60_000)
    utimesSync(join(binDir, 'fakecli'), updated, updated)
    await cache.run(input(), discover)
    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('keeps accounts apart and answers a failing CLI from its record for the retry window', async () => {
    let now = 1_000_000
    const cache = createModelDiscoveryCache({ now: () => now })
    const discover = vi
      .fn<() => Promise<DiscoverCommitMessageModelsResult>>()
      .mockResolvedValueOnce({ success: false, error: 'signed out' })
      .mockResolvedValue(listing('sonnet'))

    await expect(cache.run(input(), discover)).resolves.toMatchObject({ success: false })
    // Why: a signed-out or broken CLI is not run again on every launcher opening.
    now += MODEL_DISCOVERY_FAILURE_CACHE_TTL_MS - 1
    await expect(cache.run(input(), discover)).resolves.toMatchObject({ success: false })
    expect(discover).toHaveBeenCalledTimes(1)
    now += 1
    await expect(cache.run(input(), discover)).resolves.toMatchObject({ success: true })
    expect(MODEL_DISCOVERY_FAILURE_CACHE_TTL_MS).toBeLessThan(MODEL_DISCOVERY_CACHE_TTL_MS)

    await cache.run(input({ CLAUDE_CONFIG_DIR: '/home/tester/.claude-work' }), discover)
    expect(discover).toHaveBeenCalledTimes(3)
    await cache.run(input({ CLAUDE_CONFIG_DIR: '/home/tester/.claude-work' }), discover)
    expect(discover).toHaveBeenCalledTimes(3)
  })

  it('forgets a failed listing as soon as the CLI binary changes (an update)', async () => {
    const cache = createModelDiscoveryCache()
    const discover = vi
      .fn<() => Promise<DiscoverCommitMessageModelsResult>>()
      .mockResolvedValueOnce({ success: false, error: 'too old' })
      .mockResolvedValue(listing('opus'))
    await cache.run(input(), discover)
    await cache.run(input(), discover)
    expect(discover).toHaveBeenCalledTimes(1)

    const updated = new Date(Date.now() + 60_000)
    utimesSync(join(binDir, 'fakecli'), updated, updated)
    await expect(cache.run(input(), discover)).resolves.toMatchObject({ success: true })
    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('remembers any keyed answer: a good one for the lifetime, a failed one for the retry window', async () => {
    let now = 1_000_000
    const cache = createModelDiscoveryCache({ now: () => now })
    const compute = vi.fn(async () => (now < 2_000_000 ? null : 'eligible'))
    const remember = () => cache.remember(['remote', 'conn-1'], compute, (value) => value !== null)

    await expect(remember()).resolves.toBeNull()
    await expect(remember()).resolves.toBeNull()
    expect(compute).toHaveBeenCalledTimes(1)
    now = 2_000_000 + MODEL_DISCOVERY_FAILURE_CACHE_TTL_MS
    await expect(remember()).resolves.toBe('eligible')
    now += MODEL_DISCOVERY_CACHE_TTL_MS - 1
    await expect(remember()).resolves.toBe('eligible')
    expect(compute).toHaveBeenCalledTimes(2)
    await expect(
      cache.remember(['remote', 'conn-2'], compute, (value) => value !== null)
    ).resolves.toBe('eligible')
    expect(compute).toHaveBeenCalledTimes(3)
  })

  it('keeps a listing past the app’s own listing lifetime, so a re-list then is answered here', async () => {
    let now = 1_000_000
    const cache = createModelDiscoveryCache({ now: () => now })
    const discover = vi.fn(async () => listing('opus'))
    await cache.run(input(), discover)
    // The renderer lists again once its own copy is a lifetime old; no CLI runs for that.
    now += MODEL_LISTING_LIFETIME_MS + 1
    await cache.run(input(), discover)
    expect(discover).toHaveBeenCalledTimes(1)
    expect(MODEL_DISCOVERY_CACHE_TTL_MS).toBeGreaterThan(MODEL_LISTING_LIFETIME_MS)
  })

  it('keeps a listing that fell back to the seed catalog only for the failure window', async () => {
    let now = 1_000_000
    const cache = createModelDiscoveryCache({ now: () => now })
    // Exit 0 with no parsable models (a `list_models` error, a token-refresh blip): the seed.
    const seed = { ...listing('opus'), catalogOrigin: 'spec' as const }
    const discover = vi
      .fn<() => Promise<DiscoverCommitMessageModelsResult>>()
      .mockResolvedValueOnce(seed)
      .mockResolvedValue(listing('sonnet'))
    await expect(cache.run(input(), discover)).resolves.toEqual(seed)
    now += MODEL_DISCOVERY_FAILURE_CACHE_TTL_MS
    await expect(cache.run(input(), discover)).resolves.toEqual(listing('sonnet'))
    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('an explicit refresh runs a failed listing again but still reuses a good one', async () => {
    const cache = createModelDiscoveryCache()
    const discover = vi
      .fn<() => Promise<DiscoverCommitMessageModelsResult>>()
      .mockResolvedValueOnce({ success: false, error: 'token refresh failed' })
      .mockResolvedValue(listing('opus'))
    await cache.run(input(), discover)
    await cache.run(input(), discover)
    expect(discover).toHaveBeenCalledTimes(1)

    // A launch re-checks a CLI whose last listing failed...
    await expect(cache.run({ ...input(), force: true }, discover)).resolves.toEqual(listing('opus'))
    expect(discover).toHaveBeenCalledTimes(2)
    // ...while a good listing for the same binary and account is answered from the record.
    await expect(cache.run({ ...input(), force: true }, discover)).resolves.toEqual(listing('opus'))
    expect(discover).toHaveBeenCalledTimes(2)

    // The same for any keyed answer (a remote host's listing, OMP's routing check).
    const succeeded = (value: string | null) => value !== null
    const unlisted = vi.fn(async (): Promise<string | null> => null)
    await cache.remember(['remote', 'conn-1'], unlisted, succeeded)
    await cache.remember(['remote', 'conn-1'], unlisted, succeeded)
    expect(unlisted).toHaveBeenCalledOnce()
    const recompute = vi.fn(async (): Promise<string | null> => 'eligible')
    await expect(
      cache.remember(['remote', 'conn-1'], recompute, succeeded, { force: true })
    ).resolves.toBe('eligible')
    expect(recompute).toHaveBeenCalledOnce()
  })

  it('an explicit refresh shares a listing already running rather than starting another', async () => {
    const cache = createModelDiscoveryCache()
    let finish!: (value: DiscoverCommitMessageModelsResult) => void
    const discover = vi.fn(
      () => new Promise<DiscoverCommitMessageModelsResult>((resolve) => (finish = resolve))
    )
    const first = cache.run(input(), discover)
    const forced = cache.run({ ...input(), force: true }, discover)
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(1))
    finish(listing('haiku'))
    await expect(Promise.all([first, forced])).resolves.toEqual([
      listing('haiku'),
      listing('haiku')
    ])
    expect(discover).toHaveBeenCalledTimes(1)
  })

  it('shares one listing between callers that ask while it runs', async () => {
    const cache = createModelDiscoveryCache()
    let finish!: (value: DiscoverCommitMessageModelsResult) => void
    const discover = vi.fn(
      () => new Promise<DiscoverCommitMessageModelsResult>((resolve) => (finish = resolve))
    )
    const first = cache.run(input(), discover)
    const second = cache.run(input(), discover)
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(1))
    finish(listing('haiku'))
    await expect(Promise.all([first, second])).resolves.toEqual([
      listing('haiku'),
      listing('haiku')
    ])
  })

  it('files a listing under the selected account, looked up before any account is set up', async () => {
    const fingerprint = vi.fn(async (): Promise<string | null> => '/usr/local/bin/claude:1:1')
    const cache = createModelDiscoveryCache({ fingerprint })
    const plan = { binary: 'claude', args: ['-p'], stdinPayload: '{}\n' }
    const setUpAndList = vi
      .fn<() => Promise<DiscoverCommitMessageModelsResult>>()
      .mockResolvedValue(listing('opus'))
    const open = (account: string | null, force?: boolean) =>
      cache.runForAccount({ agentId: 'claude', plan, account, force }, setUpAndList)

    await expect(open('seat-1')).resolves.toEqual(listing('opus'))
    await expect(open('seat-1')).resolves.toEqual(listing('opus'))
    expect(setUpAndList).toHaveBeenCalledTimes(1)
    // Another selected account, or the system default, is a listing of its own.
    await open('seat-2')
    await open(null)
    expect(setUpAndList).toHaveBeenCalledTimes(3)

    // A failed listing is answered from its record until a launch asks again.
    setUpAndList.mockResolvedValueOnce({ success: false, error: 'signed out' })
    await expect(open('seat-3')).resolves.toMatchObject({ success: false })
    await expect(open('seat-3')).resolves.toMatchObject({ success: false })
    expect(setUpAndList).toHaveBeenCalledTimes(4)
    await expect(open('seat-3', true)).resolves.toEqual(listing('opus'))
    await expect(open('seat-3', true)).resolves.toEqual(listing('opus'))
    expect(setUpAndList).toHaveBeenCalledTimes(5)

    // A CLI that cannot be pinned to a file sets up and lists every time.
    fingerprint.mockResolvedValue(null)
    await open('seat-1')
    await open('seat-1')
    expect(setUpAndList).toHaveBeenCalledTimes(7)
  })

  it('does not cache a CLI it cannot pin to a file (not on PATH, or inside WSL)', async () => {
    const cache = createModelDiscoveryCache()
    const discover = vi.fn(async () => listing('opus'))
    await cache.run({ ...input(), env: { PATH: join(binDir, 'missing') } }, discover)
    await cache.run({ ...input(), env: { PATH: join(binDir, 'missing') } }, discover)
    expect(discover).toHaveBeenCalledTimes(2)
    await expect(
      resolveModelDiscoveryBinaryFingerprint('fakecli', env, 'Ubuntu')
    ).resolves.toBeNull()
    await expect(resolveModelDiscoveryBinaryFingerprint('fakecli', env)).resolves.toContain(
      'fakecli:'
    )
  })
})
