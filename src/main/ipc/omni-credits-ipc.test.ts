import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import { routes } from '../backoffice/console-workflow-routes'
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  send: vi.fn(),
  request: vi.fn(),
  scope: {
    principal: 'sal',
    baseUrl: 'https://omni.test',
    profileKey: 'p',
    sessionIdentity: 'org-a'
  },
  identityChanged: undefined as undefined | (() => void),
  exhausted: undefined as undefined | ((event: unknown) => void),
  enabled: true
}))
vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: vi.fn(),
    handle: (key: string, fn: (...args: unknown[]) => unknown) => mocks.handlers.set(key, fn)
  },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }]
  }
}))
vi.mock('../backoffice/console-workflow-person', () => ({
  currentConsolePublicationScope: () => mocks.scope
}))
vi.mock('../backoffice/console-workflow-transport', () => ({
  requestConsoleWorkflow: mocks.request,
  onConsoleCreditsExhausted: (fn: (event: unknown) => void) => {
    mocks.exhausted = fn
  }
}))
vi.mock('../omni-profiles/profile-cloud-session-mutation', () => ({
  subscribeCloudSessionMutations: (fn: () => void) => {
    mocks.identityChanged = fn
    return () => {}
  }
}))
import { registerOmniCreditsIpc } from './omni-credits-ipc'
const read = () => mocks.handlers.get('omni:credits:get-wallet')!()
const refresh = () => mocks.handlers.get('omni:credits:refresh-wallet')!()
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(100000)
  mocks.enabled = true
  mocks.scope.principal = 'sal'
  mocks.scope.sessionIdentity = 'org-a'
  mocks.request.mockReset().mockResolvedValue({ ok: true, data: { enabled: true, balance: 40 } })
  mocks.send.mockClear()
  registerOmniCreditsIpc({
    getSettings: () => ({ experimentalOmniCredits: mocks.enabled })
  } as Store)
})
afterEach(() => vi.useRealTimers())
describe('Omni credits IPC', () => {
  it('allows only the exact read route', () => {
    expect(routes.GET.some((r) => r.test.test('/api/credits'))).toBe(true)
    for (const path of ['/api/credits?admin=true', '/api/credits/spend']) {
      expect(routes.GET.some((r) => r.test.test(path))).toBe(false)
    }
    expect(routes.POST.some((r) => r.test.test('/api/credits'))).toBe(false)
  })
  it('does no work when disabled and suppresses error pushes', async () => {
    mocks.enabled = false
    expect(await read()).toBeNull()
    mocks.exhausted?.({ error: 'credits_exhausted' })
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })
  it('shares in-flight reads, caches 30 seconds, and gives the transport an 8s deadline', async () => {
    let resolve!: (value: unknown) => void
    mocks.request.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        })
    )
    const first = read()
    const second = read()
    expect(mocks.request).toHaveBeenCalledTimes(1)
    resolve({ ok: true, data: { enabled: true, balance: 40 } })
    expect(await first).toEqual(await second)
    await read()
    expect(mocks.request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30001)
    await read()
    expect(mocks.request).toHaveBeenCalledTimes(2)
    expect(mocks.request.mock.calls[0][4]).toBe(8000)
    await refresh()
    expect(mocks.request).toHaveBeenCalledTimes(3)
  })
  it('clears on 404, disabled server, and identity changes', async () => {
    await read()
    mocks.request.mockResolvedValueOnce({ ok: false, error: { status: 404 } })
    expect(await refresh()).toBeNull()
    mocks.request.mockResolvedValueOnce({ ok: true, data: { enabled: false, balance: 50 } })
    expect(await refresh()).toBeNull()
    mocks.scope.principal = 'member'
    expect(await read()).toMatchObject({ balance: 40 })
    expect(mocks.request).toHaveBeenCalledTimes(4)
  })
  it('discards a late response after account or setting changes', async () => {
    let resolve!: (value: unknown) => void
    mocks.request.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        })
    )
    const pending = read()
    mocks.scope.principal = 'other'
    resolve({ ok: true, data: { enabled: true, balance: 999 } })
    expect(await pending).toBeNull()
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith('omni:credits:wallet-changed', null)
  })
  it('reserves across windows, releases unseen prompts and consumes only acknowledged displays', () => {
    const event = { sender: { id: 1, once: vi.fn() } }
    const other = { sender: { id: 2, once: vi.fn() } }
    const claim = (period: string, id: string, owner = event) =>
      mocks.handlers.get('omni:credits:claim-upgrade')!(owner, period, id)
    const finish = (id: string, shown: boolean, owner = event) =>
      mocks.handlers.get('omni:credits:finish-upgrade')!(owner, id, shown)
    expect(claim('nov', 'a')).toBe(true)
    expect(claim('nov', 'b', other)).toBe(false)
    finish('a', false, other)
    expect(claim('nov', 'b', other)).toBe(false)
    finish('a', false)
    expect(claim('nov', 'b')).toBe(true)
    finish('b', true)
    expect(claim('nov', 'c')).toBe(false)
    expect(claim('dec', 'd')).toBe(true)
    mocks.scope.principal = 'other'
    expect(claim('nov', 'e')).toBe(true)
  })
  it('reconciles an acknowledged unknown period when the wallet arrives', async () => {
    const event = { sender: { id: 1, once: vi.fn() } }
    expect(mocks.handlers.get('omni:credits:claim-upgrade')!(event, '', 'a')).toBe(true)
    mocks.handlers.get('omni:credits:finish-upgrade')!(event, 'a', true)
    mocks.request.mockResolvedValueOnce({
      ok: true,
      data: { enabled: true, balance: 0, period: { end: 'nov' } }
    })
    await read()
    expect(mocks.handlers.get('omni:credits:claim-upgrade')!(event, 'nov', 'b')).toBe(false)
    expect(mocks.handlers.get('omni:credits:claim-upgrade')!(event, 'dec', 'c')).toBe(true)
  })
  it('pushes main-observed exhausted events', () => {
    const event = { error: 'credits_exhausted', needed: 576, balance: 40 }
    mocks.exhausted?.(event)
    expect(mocks.send).toHaveBeenCalledWith('omni:credits:credits_exhausted', event)
  })
})

it('isolates wallet, members, in-flight reads and prompt periods across organizations', async () => {
  const event = { sender: { id: 1, once: vi.fn() } }
  const claim = (id: string) => mocks.handlers.get('omni:credits:claim-upgrade')!(event, 'nov', id)
  mocks.request.mockResolvedValueOnce({
    ok: true,
    data: { enabled: true, balance: 111, members: [{ name: 'Org A admin' }] }
  })
  expect(await read()).toMatchObject({ balance: 111 })
  expect(claim('a')).toBe(true)
  mocks.handlers.get('omni:credits:finish-upgrade')!(event, 'a', true)
  let resolve!: (value: unknown) => void
  mocks.request.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  const pendingA = refresh()
  mocks.scope.sessionIdentity = 'org-b'
  expect(await read()).toMatchObject({ balance: 40 })
  expect(await read()).not.toHaveProperty('members')
  expect(claim('b')).toBe(true)
  resolve({ ok: true, data: { enabled: true, balance: 111 } })
  expect(await pendingA).toBeNull()
})
it('invalidates late reads when the same identity signs in again', async () => {
  let resolve!: (value: unknown) => void
  mocks.request.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  const pending = read()
  mocks.identityChanged?.()
  resolve({ ok: true, data: { enabled: true, balance: 111 } })
  expect(await pending).toBeNull()
  expect(await read()).toMatchObject({ balance: 40 })
})
