import { describe, expect, it, vi } from 'vitest'
import type { AppHealthReportBody } from '../../shared/app-health-contract'
import {
  APP_HEALTH_DEDUPE_WINDOW_MS,
  APP_HEALTH_QUEUE_LIMIT,
  AppHealthReporter
} from './app-health-reporter'

function harness(options: { signedIn?: boolean; now?: () => number } = {}) {
  const sent: AppHealthReportBody[] = []
  let release: (() => void) | null = null
  const send = vi.fn(async (body: AppHealthReportBody) => {
    sent.push(body)
    if (release) {
      await new Promise<void>((resolve) => {
        release = resolve
      })
    }
    return { ok: true as const, data: {} }
  })
  const reporter = new AppHealthReporter({
    send,
    isSignedIn: () => options.signedIn ?? true,
    appVersion: () => '1.10.12',
    platform: () => 'darwin',
    now: options.now ?? (() => 1_000)
  })
  return { reporter, sent, send, hold: () => (release = () => undefined) }
}

describe('AppHealthReporter', () => {
  it('stamps app, version, platform and time onto a report and sends it', async () => {
    const { reporter, sent } = harness()
    reporter.report({
      feature: 'startup',
      status: 'ok',
      code: 'signed_in',
      message: ' ready \n now '
    })
    await reporter.flush()
    expect(sent).toEqual([
      {
        app: 'omni-ide',
        version: '1.10.12',
        platform: 'darwin',
        feature: 'startup',
        status: 'ok',
        code: 'signed_in',
        message: 'ready now',
        at: '1970-01-01T00:00:01.000Z'
      }
    ])
  })

  it('sends nothing when signed out', async () => {
    const { reporter, send } = harness({ signedIn: false })
    reporter.report({ feature: 'team_memory', status: 'error', code: 'not_signed_in' })
    await reporter.flush()
    expect(send).not.toHaveBeenCalled()
    await expect(reporter.reportAndWait({ feature: 'crash', status: 'crash' })).resolves.toEqual({
      ok: false,
      status: null,
      error: 'Sign in to OmniConsole to send a report.'
    })
  })

  it('dedupes the same feature and code inside five minutes, but never a crash', async () => {
    let now = 1_000
    const { reporter, sent } = harness({ now: () => now })
    reporter.report({ feature: 'transcript_upload', status: 'error', code: 'http_500' })
    reporter.report({ feature: 'transcript_upload', status: 'error', code: 'http_500' })
    reporter.report({ feature: 'transcript_upload', status: 'error', code: 'http_502' })
    reporter.report({ feature: 'crash', status: 'crash', code: 'oom' })
    reporter.report({ feature: 'crash', status: 'crash', code: 'oom' })
    await reporter.flush()
    expect(sent.map((body) => `${body.feature}:${body.code}`)).toEqual([
      'transcript_upload:http_500',
      'transcript_upload:http_502',
      'crash:oom',
      'crash:oom'
    ])
    now += APP_HEALTH_DEDUPE_WINDOW_MS
    reporter.report({ feature: 'transcript_upload', status: 'error', code: 'http_500' })
    await reporter.flush()
    expect(sent).toHaveLength(5)
  })

  it('keeps at most the newest fifty queued reports', async () => {
    const { reporter, sent, hold } = harness()
    hold()
    for (let index = 0; index < APP_HEALTH_QUEUE_LIMIT + 10; index++) {
      reporter.report({ feature: 'crash', status: 'crash', code: `c${index}` })
    }
    // The first report is in flight (held); the queue behind it is capped.
    expect(reporter.pendingCount()).toBe(APP_HEALTH_QUEUE_LIMIT)
    expect(sent).toHaveLength(1)
  })

  it('reportAndWait returns the transport refusal with its status', async () => {
    const reporter = new AppHealthReporter({
      send: async () => ({
        ok: false as const,
        error: { code: 'forbidden', message: 'no', status: 403 }
      }),
      isSignedIn: () => true,
      appVersion: () => '1',
      platform: () => 'linux'
    })
    await expect(
      reporter.reportAndWait({ feature: 'crash', status: 'crash', code: 'x' })
    ).resolves.toEqual({ ok: false, status: 403, error: 'no' })
  })
})
