import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LayaShadow } from './laya-shadow'
import { parseDecisionConfiguration } from './decision-configuration'

const directories: string[] = []
const shadows: LayaShadow[] = []
afterEach(async () => {
  shadows.splice(0).forEach((shadow) => shadow.service.dispose())
  vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('Laya shadow admission', () => {
  it('defaults off, redacts configuration secrets and respects global disable and owner fencing', async () => {
    const path = await mkdtemp(join(tmpdir(), 'laya-shadow-'))
    directories.push(path)
    const baseline = {
      version: 1,
      enabled: true,
      capabilities: { 'routine.structured': { mode: 'live' } },
      routines: {}
    }
    const configuration = vi.fn(() => parseDecisionConfiguration(baseline))
    const routineMode = vi.fn(() => 'off' as const)
    const shadow = new LayaShadow(path, { configuration, routineMode })
    shadows.push(shadow)
    expect(await shadow.status()).toMatchObject({ configured: false, enabled: false })
    const secret = 'c'.repeat(64)
    await writeFile(
      join(path, 'laya-shadow.json'),
      JSON.stringify({
        version: 1,
        enabled: true,
        capabilities: ['routine.structured'],
        token: secret
      })
    )
    expect(await shadow.status()).toMatchObject({ configured: true, enabled: true })
    expect(JSON.stringify(await shadow.status())).not.toContain(secret)
    const fetcher = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetcher)
    const request = {
      capability: 'routine.structured',
      routineId: 'remote-routine',
      state: 'example',
      questions: { answer: { type: 'noul' as const, instructions: 'True?' } }
    }
    const result = {
      provider: 'typesafe',
      model: 'jev-1.13.0',
      answers: { answer: { type: 'noul' as const, noul: 0.9 } },
      usage: { inputTokens: 1, outputTokens: 1 }
    }
    shadow.observe(request, result)
    await vi.waitFor(() => expect(shadow.service.telemetry.snapshot()).toHaveLength(1))
    expect(shadow.service.telemetry.snapshot()[0]).toMatchObject({ reason: 'routine_not_enabled' })
    baseline.enabled = false
    shadow.observe(request, result)
    await vi.waitFor(() => expect(shadow.service.telemetry.snapshot()).toHaveLength(2))
    expect(shadow.service.telemetry.snapshot()[1]).toMatchObject({ reason: 'disabled' })
    expect(fetcher).not.toHaveBeenCalled()
  })
})
