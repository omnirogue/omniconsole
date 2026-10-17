import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DECISION_MAX_TIMEOUT_MS } from '../../shared/structured-decisions'
import {
  createDecisionConfigurationReader,
  DECISION_KILL_ENV,
  disabledDecisionConfiguration,
  parseDecisionConfiguration
} from './decision-configuration'

const tempDirectories: string[] = []
const enabledConfiguration = {
  version: 1,
  enabled: true,
  capabilities: { 'orchestration.route': { mode: 'shadow' } }
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('parseDecisionConfiguration', () => {
  it('uses bounded defaults without silently enabling routines', () => {
    expect(parseDecisionConfiguration(enabledConfiguration)).toEqual({
      ...enabledConfiguration,
      valid: true,
      killSwitch: false,
      timeoutMs: DECISION_MAX_TIMEOUT_MS,
      routines: {}
    })
    expect(
      parseDecisionConfiguration({
        ...enabledConfiguration,
        killSwitch: true,
        model: 'jev-1.13.0',
        timeoutMs: 750,
        routines: { 'routine:one': { mode: 'live' } }
      })
    ).toMatchObject({ valid: true, killSwitch: true, model: 'jev-1.13.0', timeoutMs: 750 })
  })

  it.each([
    null,
    [],
    {},
    { ...enabledConfiguration, version: 2 },
    { ...enabledConfiguration, enabled: 'true' },
    { ...enabledConfiguration, timeoutMs: 0 },
    { ...enabledConfiguration, timeoutMs: 0.5 },
    { ...enabledConfiguration, timeoutMs: DECISION_MAX_TIMEOUT_MS + 1 },
    { ...enabledConfiguration, timeoutMs: Number.NaN },
    { ...enabledConfiguration, model: 'https://provider.example/model' },
    { ...enabledConfiguration, apiKey: 'secret-must-not-be-configured-here' },
    { ...enabledConfiguration, capabilities: { routing: { mode: 'automatic' } } },
    { ...enabledConfiguration, capabilities: { routing: { mode: 'live', enabled: true } } },
    { ...enabledConfiguration, routines: { 'unsafe routine': { mode: 'live' } } }
  ])('fails closed for malformed or unsupported configuration: %j', (input) => {
    expect(parseDecisionConfiguration(input)).toEqual(disabledDecisionConfiguration())
  })

  it('does not share mutable capability or routine maps between disabled results', () => {
    const first = disabledDecisionConfiguration()
    first.capabilities.routing = { mode: 'live' }
    first.routines.routine = { mode: 'live' }

    expect(disabledDecisionConfiguration()).toMatchObject({
      valid: false,
      enabled: false,
      killSwitch: true,
      capabilities: {},
      routines: {}
    })
  })
})

describe('createDecisionConfigurationReader', () => {
  it('awaits every read and reloads changes without retaining a previous enabled result', async () => {
    let completeRead!: (text: string) => void
    const pending = new Promise<string>((resolve) => {
      completeRead = resolve
    })
    const readText = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(JSON.stringify({ ...enabledConfiguration, enabled: false }))
      .mockRejectedValueOnce(new Error('configuration disappeared'))
      .mockResolvedValueOnce(JSON.stringify(enabledConfiguration))
    const read = createDecisionConfigurationReader('unused.json', {
      environment: () => ({}),
      readText
    })
    const first = Promise.resolve(read())
    const completed = vi.fn()
    void first.then(completed)
    await Promise.resolve()
    expect(completed).not.toHaveBeenCalled()

    completeRead(JSON.stringify(enabledConfiguration))
    await expect(first).resolves.toMatchObject({ valid: true, enabled: true })
    await expect(read()).resolves.toMatchObject({ valid: true, enabled: false })
    await expect(read()).resolves.toEqual(disabledDecisionConfiguration())
    await expect(read()).resolves.toMatchObject({ valid: true, enabled: true })
    expect(readText).toHaveBeenCalledTimes(4)
  })

  it.each(['1', 'true', 'TRUE', 'yes', 'unexpected', ' '])(
    'gives the environment kill switch precedence over enabled configuration: %j',
    async (kill) => {
      const readText = vi.fn().mockResolvedValue(JSON.stringify(enabledConfiguration))
      const read = createDecisionConfigurationReader('unused.json', {
        environment: () => ({ [DECISION_KILL_ENV]: kill }),
        readText
      })

      await expect(read()).resolves.toEqual(disabledDecisionConfiguration())
      expect(readText).not.toHaveBeenCalled()
    }
  )

  it.each([undefined, '', '0', 'false', 'FALSE', 'FaLsE'])(
    'allows the configuration to decide when the environment kill switch is clear: %j',
    async (kill) => {
      const read = createDecisionConfigurationReader('unused.json', {
        environment: () => ({ [DECISION_KILL_ENV]: kill }),
        readText: async () => JSON.stringify(enabledConfiguration)
      })
      await expect(read()).resolves.toMatchObject({ valid: true, enabled: true })
    }
  )

  it('observes process environment changes between reads instead of caching the kill switch', async () => {
    vi.stubEnv(DECISION_KILL_ENV, 'false')
    const readText = vi.fn().mockResolvedValue(JSON.stringify(enabledConfiguration))
    const read = createDecisionConfigurationReader('unused.json', { readText })

    await expect(read()).resolves.toMatchObject({ enabled: true })
    vi.stubEnv(DECISION_KILL_ENV, '1')
    await expect(read()).resolves.toEqual(disabledDecisionConfiguration())
    vi.stubEnv(DECISION_KILL_ENV, '0')
    await expect(read()).resolves.toMatchObject({ enabled: true })
    expect(readText).toHaveBeenCalledTimes(2)
  })

  it('fails closed when the environment kill switch is enabled during an outstanding read', async () => {
    let kill = 'false'
    let completeRead!: (text: string) => void
    const pending = new Promise<string>((resolve) => {
      completeRead = resolve
    })
    const read = createDecisionConfigurationReader('unused.json', {
      environment: () => ({ [DECISION_KILL_ENV]: kill }),
      readText: () => pending
    })
    const reading = read()
    kill = 'true'
    completeRead(JSON.stringify(enabledConfiguration))

    await expect(reading).resolves.toEqual(disabledDecisionConfiguration())
  })

  it('fails closed when environment access throws', async () => {
    const readText = vi.fn()
    const read = createDecisionConfigurationReader('unused.json', {
      environment: () => {
        throw new Error('environment unavailable')
      },
      readText
    })
    await expect(read()).resolves.toEqual(disabledDecisionConfiguration())
    expect(readText).not.toHaveBeenCalled()
  })

  it.each(['', '{', 'null', '[]', JSON.stringify({ ...enabledConfiguration, capabilities: null })])(
    'fails closed on unreadable configuration content: %j',
    async (text) => {
      const read = createDecisionConfigurationReader('unused.json', {
        environment: () => ({}),
        readText: async () => text
      })
      await expect(read()).resolves.toEqual(disabledDecisionConfiguration())
    }
  )

  it('enforces the same 32 KiB boundary on injected reads as on files', async () => {
    const text = JSON.stringify(enabledConfiguration).padEnd(32 * 1024, ' ')
    const readText = vi.fn().mockResolvedValueOnce(text).mockResolvedValueOnce(`${text} `)
    const read = createDecisionConfigurationReader('unused.json', {
      environment: () => ({}),
      readText
    })

    await expect(read()).resolves.toMatchObject({ valid: true })
    await expect(read()).resolves.toEqual(disabledDecisionConfiguration())
  })

  it('reloads the actual file and recovers after missing, oversized, and malformed content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'decision-configuration-'))
    tempDirectories.push(directory)
    const path = join(directory, 'decisions.json')
    const read = createDecisionConfigurationReader(path, { environment: () => ({}) })
    await expect(read()).resolves.toEqual(disabledDecisionConfiguration())

    await writeFile(path, JSON.stringify(enabledConfiguration).padEnd(32 * 1024, ' '))
    await expect(read()).resolves.toMatchObject({ valid: true, enabled: true })
    await writeFile(path, JSON.stringify(enabledConfiguration).padEnd(32 * 1024 + 1, ' '))
    await expect(read()).resolves.toEqual(disabledDecisionConfiguration())
    await writeFile(path, '{')
    await expect(read()).resolves.toEqual(disabledDecisionConfiguration())
    await writeFile(path, JSON.stringify({ ...enabledConfiguration, killSwitch: true }))
    await expect(read()).resolves.toMatchObject({ valid: true, killSwitch: true })
  })
})
