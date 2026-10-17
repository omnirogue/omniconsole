import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionFrameLogStatus } from '../../../../shared/session-frame-log'
import type { SessionSidebarCountsResult } from '../../../../shared/session-sidebar-counts'
import {
  _configureSessionFrameLogForTests,
  _resetSessionFrameLogForTests
} from '../../../observability/session-frame-log'
import type { RpcContext, RpcMethod } from '../core'
import { SESSION_FRAME_LOG_METHODS } from './session-frame-log'
import { SESSION_ORGANIZATION_LOCAL_ONLY_ERROR } from './session-organization'

const WINDOW = {
  clientId: 'desktop-renderer',
  clientKind: 'runtime',
  connectionId: 'desktop-renderer:1'
} as const

function call<T>(
  name: string,
  params: unknown,
  extra: Partial<RpcContext> = {},
  requestSessionFolders: () => Promise<unknown> = async () => undefined
): Promise<T> {
  const method = SESSION_FRAME_LOG_METHODS.find((entry) => entry.name === name) as RpcMethod
  const parsed = method.params ? method.params.parse(params) : params
  const runtime = { requestSessionFolders } as unknown as RpcContext['runtime']
  // Why a promise: a handler's synchronous refusal must read as a rejection, like the dispatcher's.
  return new Promise<T>((resolve) =>
    resolve(method.handler(parsed, { ...extra, runtime } as RpcContext) as T)
  )
}

describe('session.frameLog.* and session.sidebarCounts', () => {
  let directory: string

  beforeEach(async () => {
    await _resetSessionFrameLogForTests()
    directory = mkdtempSync(join(tmpdir(), 'frame-log-rpc-'))
    _configureSessionFrameLogForTests({
      directory,
      writerFactory: () => ({ push: () => {}, flush: async () => {} })
    })
  })

  afterEach(async () => {
    await _resetSessionFrameLogForTests()
    rmSync(directory, { recursive: true, force: true })
  })

  it.each([
    ['a paired runtime', { clientKind: 'runtime', pairedDeviceId: 'studio' }],
    ['a phone', { clientKind: 'mobile', clientId: 'phone-1' }],
    ['a remote client', { clientId: 'remote-client' }]
  ] as const)('refuses %s on every method, changing nothing', async (_label, caller) => {
    for (const [name, params] of [
      ['session.frameLog.set', { enabled: true }],
      ['session.frameLog.status', null],
      ['session.sidebarCounts', null]
    ] as const) {
      await expect(call(name, params, caller)).rejects.toThrow(
        SESSION_ORGANIZATION_LOCAL_ONLY_ERROR
      )
    }
    const status = await call<SessionFrameLogStatus>('session.frameLog.status', null)
    expect(status.enabled).toBe(false)
  })

  it('lets the local CLI and the window switch it, with a bounded duration', async () => {
    const on = await call<SessionFrameLogStatus>('session.frameLog.set', {
      enabled: true,
      durationMs: 60_000
    })
    expect(on.enabled).toBe(true)
    expect(on.expiresAt! - on.enabledAt!).toBeLessThanOrEqual(60_000 + 1000)
    expect(() =>
      call('session.frameLog.set', { enabled: true, durationMs: 49 * 60 * 60 * 1000 })
    ).toThrow()
    const off = await call<SessionFrameLogStatus>(
      'session.frameLog.set',
      { enabled: false },
      WINDOW
    )
    expect(off.enabled).toBe(false)
  })

  it('reports no counts when no window answers or an old window answers nothing', async () => {
    const noWindow = await call<SessionSidebarCountsResult>('session.sidebarCounts', null, {}, () =>
      Promise.reject(new Error('No OmniConsole window is open.'))
    )
    expect(noWindow).toMatchObject({
      available: false,
      reason: 'No OmniConsole window is open.',
      switchHostCounts: [],
      archivedCount: null,
      build: expect.objectContaining({ commit: null })
    })

    const oldWindow = await call<SessionSidebarCountsResult>('session.sidebarCounts', null)
    expect(oldWindow).toMatchObject({ available: false, rows: [] })
    expect(oldWindow.reason).toMatch(/Reload OmniConsole/)
  })

  it('passes the window’s own unavailable answer through with the build stamped', async () => {
    const offScreen = await call<SessionSidebarCountsResult>(
      'session.sidebarCounts',
      null,
      {},
      async () => ({ available: false, reason: 'sidebar not on screen', onScreen: false })
    )
    expect(offScreen).toMatchObject({
      available: false,
      reason: 'sidebar not on screen',
      build: expect.any(Object)
    })
  })
})
