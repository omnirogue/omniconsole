import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CrashReportRecord } from '../../shared/crash-reporting'
import { crashHealthReport, reportNewCrashesOnLaunch } from './crash-health-on-launch'

function report(id: string, createdAt: string, reason = 'Renderer crashed'): CrashReportRecord {
  return {
    id,
    createdAt,
    status: 'pending',
    source: 'renderer',
    processType: 'renderer',
    reason,
    exitCode: 5,
    appVersion: '1.0.0',
    platform: 'darwin',
    osRelease: 'x',
    arch: 'arm64',
    electronVersion: '41',
    chromeVersion: '141',
    details: { secret: 'never sent' }
  }
}

describe('crash health on launch', () => {
  it('builds a crash row from the id and reason only', () => {
    expect(
      crashHealthReport(report('crash-1', '2026-09-13T01:00:00.000Z', 'Out of Memory'))
    ).toEqual({
      feature: 'crash',
      status: 'crash',
      code: 'out_of_memory',
      message: 'crash-1 renderer Out of Memory',
      at: '2026-09-13T01:00:00.000Z'
    })
  })

  it('reports each new report once across launches, baselining old ones on the first run', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'crash-health-'))
    const now = Date.parse('2026-09-13T12:00:00.000Z')
    const old = report('old', '2026-09-01T00:00:00.000Z')
    const recent = report('recent', '2026-09-13T11:00:00.000Z')
    const sent: string[] = []
    const send = vi.fn(async (input: { message?: string }) => {
      sent.push(input.message ?? '')
      return { ok: true }
    })

    const first = await reportNewCrashesOnLaunch({
      userDataPath,
      signedIn: true,
      listRecent: async () => [recent, old],
      report: send,
      now: () => now
    })
    expect(first).toBe(1)
    expect(sent).toEqual(['recent renderer Renderer crashed'])
    expect(
      (
        JSON.parse(
          await readFile(join(userDataPath, 'app-health-reported-crashes.json'), 'utf8')
        ) as string[]
      ).sort()
    ).toEqual(['old', 'recent'])

    const later = report('later', '2026-09-13T12:30:00.000Z')
    const second = await reportNewCrashesOnLaunch({
      userDataPath,
      signedIn: true,
      listRecent: async () => [later, recent, old],
      report: send,
      now: () => now + 60_000
    })
    expect(second).toBe(1)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toContain('later')
  })

  it('signed out, neither reports nor records anything, so the crash is still new after sign-in', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'crash-health-'))
    const now = Date.parse('2026-09-13T12:00:00.000Z')
    const recent = report('recent', '2026-09-13T11:00:00.000Z')
    const send = vi.fn(async () => ({ ok: true }))

    const signedOut = await reportNewCrashesOnLaunch({
      userDataPath,
      signedIn: false,
      listRecent: async () => [recent],
      report: send,
      now: () => now
    })
    expect(signedOut).toBe(0)
    expect(send).not.toHaveBeenCalled()
    await expect(readFile(join(userDataPath, 'app-health-reported-crashes.json'))).rejects.toThrow()

    const signedIn = await reportNewCrashesOnLaunch({
      userDataPath,
      signedIn: true,
      listRecent: async () => [recent],
      report: send,
      now: () => now + 60_000
    })
    expect(signedIn).toBe(1)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('records an id only once the console accepted the row, so an outage is retried next launch', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'crash-health-'))
    const now = Date.parse('2026-09-13T12:00:00.000Z')
    const recent = report('recent', '2026-09-13T11:00:00.000Z')
    const send = vi.fn(async () => ({ ok: false }))

    expect(
      await reportNewCrashesOnLaunch({
        userDataPath,
        signedIn: true,
        listRecent: async () => [recent],
        report: send,
        now: () => now
      })
    ).toBe(0)
    expect(send).toHaveBeenCalledTimes(1)
    await expect(readFile(join(userDataPath, 'app-health-reported-crashes.json'))).rejects.toThrow()

    send.mockResolvedValue({ ok: true })
    expect(
      await reportNewCrashesOnLaunch({
        userDataPath,
        signedIn: true,
        listRecent: async () => [recent],
        report: send,
        now: () => now + 60_000
      })
    ).toBe(1)
    expect(
      JSON.parse(await readFile(join(userDataPath, 'app-health-reported-crashes.json'), 'utf8'))
    ).toEqual(['recent'])
  })
})
