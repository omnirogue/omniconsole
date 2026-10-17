import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const browserMocks = vi.hoisted(() => ({
  appGetPathMock: vi.fn(() => '/downloads'),
  shellOpenExternalMock: vi.fn(),
  browserWindowFromWebContentsMock: vi.fn(),
  menuBuildFromTemplateMock: vi.fn(),
  guestOffMock: vi.fn(),
  guestOnMock: vi.fn(),
  guestSetBackgroundThrottlingMock: vi.fn(),
  guestSetWindowOpenHandlerMock: vi.fn(),
  guestOpenDevToolsMock: vi.fn(),
  webContentsFromIdMock: vi.fn(),
  screenGetCursorScreenPointMock: vi.fn(() => ({ x: 0, y: 0 })),
  openPopupWithOriginBarMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: browserMocks.appGetPathMock
  },
  BrowserWindow: {
    fromWebContents: browserMocks.browserWindowFromWebContentsMock
  },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: browserMocks.shellOpenExternalMock },
  Menu: {
    buildFromTemplate: browserMocks.menuBuildFromTemplateMock
  },
  screen: {
    getCursorScreenPoint: browserMocks.screenGetCursorScreenPointMock
  },
  webContents: {
    fromId: browserMocks.webContentsFromIdMock
  }
}))

vi.mock('./popup-origin-bar-window', () => ({
  openPopupWithOriginBar: browserMocks.openPopupWithOriginBarMock
}))

import { browserManager } from './browser-manager'
import {
  rendererWebContentsId,
  resetBrowserManagerMocks,
  resetBrowserManagerState
} from './browser-manager-test-harness'

const {
  guestOffMock,
  guestOnMock,
  guestSetBackgroundThrottlingMock,
  guestSetWindowOpenHandlerMock,
  guestOpenDevToolsMock,
  webContentsFromIdMock
} = browserMocks

const ownedIdentities: {
  browserPageId: string
  pageHostGeneration: number
  webContentsId: number
}[] = []
let nextGuestId = 8000

function clientFixture(result?: unknown) {
  const identity = {
    browserPageId: `client-${nextGuestId}`,
    pageHostGeneration: 7,
    webContentsId: nextGuestId++
  }
  const proof = { ...identity, token: `lease-${identity.webContentsId}` }
  const guest = {
    id: identity.webContentsId,
    isDestroyed: () => false,
    getType: () => 'webview',
    setBackgroundThrottling: guestSetBackgroundThrottlingMock,
    setWindowOpenHandler: guestSetWindowOpenHandlerMock,
    on: guestOnMock,
    off: guestOffMock,
    openDevTools: guestOpenDevToolsMock,
    debugger: { isAttached: () => true, sendCommand: vi.fn(async (_method: string) => {}) }
  }
  const executeJavaScript = vi.fn().mockResolvedValue(result === undefined ? proof : result)
  const renderer = {
    id: rendererWebContentsId,
    isDestroyed: () => false,
    getZoomFactor: () => 1,
    executeJavaScript
  }
  webContentsFromIdMock.mockImplementation((id: number) =>
    id === guest.id ? guest : id === renderer.id ? renderer : null
  )
  browserManager.attachGuestPolicies(guest as never)
  expect(
    browserManager.registerGuest({
      browserPageId: identity.browserPageId,
      userAgentMode: 'native',
      webContentsId: guest.id,
      rendererWebContentsId
    })
  ).toBe(true)
  browserManager.expectClientAutomationVisibility(identity)
  ownedIdentities.push(identity)
  return { identity, proof, guest, renderer, executeJavaScript }
}

describe('retained client automation visibility admission', () => {
  beforeEach(() => {
    resetBrowserManagerMocks(browserMocks)
    resetBrowserManagerState()
  })
  afterEach(() => {
    for (const identity of ownedIdentities.splice(0)) {
      browserManager.retireClientAutomationVisibility(identity)
    }
    browserManager.unregisterAll()
    vi.useRealTimers()
  })

  it.each([
    null,
    'token-without-readiness',
    { token: 'wrong-identity', browserPageId: 'other', pageHostGeneration: 7, webContentsId: 1 }
  ])('refuses a missing or unproven renderer acquisition: %j', async (result) => {
    const fixture = clientFixture(result)
    await expect(
      browserManager.acquireAutomationVisibility(fixture.guest.id)
    ).rejects.toMatchObject({ code: 'browser_client_page_automation_guest_not_ready' })
    if (result) {
      expect(fixture.executeJavaScript.mock.calls.at(-1)?.[0]).toContain('bridge.release(')
    }
  })

  it('keeps the strict expectation when generic guest registration disappears', async () => {
    const fixture = clientFixture()
    browserManager.unregisterGuest(fixture.identity.browserPageId)
    browserManager.retireClientAutomationVisibility({ ...fixture.identity, pageHostGeneration: 8 })
    await expect(
      browserManager.acquireAutomationVisibility(fixture.guest.id)
    ).rejects.toMatchObject({ code: 'browser_client_page_automation_guest_not_ready' })
    expect(fixture.executeJavaScript).not.toHaveBeenCalled()
    browserManager.retireClientAutomationVisibility(fixture.identity)
    await expect(browserManager.acquireAutomationVisibility(fixture.guest.id)).resolves.toBeTypeOf(
      'function'
    )
  })

  it('refuses a known client whose renderer has disappeared', async () => {
    const fixture = clientFixture()
    webContentsFromIdMock.mockImplementation((id: number) =>
      id === fixture.guest.id ? fixture.guest : null
    )
    await expect(
      browserManager.acquireAutomationVisibility(fixture.guest.id)
    ).rejects.toMatchObject({ code: 'browser_client_page_automation_guest_not_ready' })
    expect(fixture.executeJavaScript).not.toHaveBeenCalled()
  })

  it('keeps queued guards tied to the original registration after retirement and replacement', () => {
    const { identity } = clientFixture()
    const guard = browserManager.captureClientAutomationVisibilityGuard(identity.webContentsId)
    expect(guard).toBeTypeOf('function')
    expect(() => guard!()).not.toThrow()
    browserManager.retireClientAutomationVisibility({ ...identity, pageHostGeneration: 8 })
    expect(() => guard!()).not.toThrow()
    browserManager.retireClientAutomationVisibility(identity)
    expect(() => guard!()).toThrow('browser_client_page_automation_guest_not_ready')
    browserManager.expectClientAutomationVisibility(identity)
    expect(() => guard!()).toThrow('browser_client_page_automation_guest_not_ready')
    expect(() =>
      browserManager.captureClientAutomationVisibilityGuard(identity.webContentsId)!()
    ).not.toThrow()
    expect(browserManager.captureClientAutomationVisibilityGuard(-1)).toBeNull()
  })

  it('rechecks ownership after the asynchronous acquisition and releases a stale proof', async () => {
    const fixture = clientFixture()
    fixture.executeJavaScript.mockImplementationOnce(async () => {
      browserManager.unregisterGuest(fixture.identity.browserPageId)
      return fixture.proof
    })
    await expect(
      browserManager.acquireAutomationVisibility(fixture.guest.id)
    ).rejects.toMatchObject({ code: 'browser_client_page_automation_guest_not_ready' })
    expect(fixture.executeJavaScript.mock.calls.at(-1)?.[0]).toContain(
      `bridge.release("${fixture.proof.token}")`
    )
  })

  it('allows IPC delivery time in addition to the renderer readiness window', async () => {
    vi.useFakeTimers()
    const fixture = clientFixture()
    fixture.executeJavaScript.mockReturnValueOnce(
      new Promise((resolve) => setTimeout(() => resolve(fixture.proof), 2500))
    )
    const acquisition = browserManager.acquireAutomationVisibility(fixture.guest.id)
    await vi.advanceTimersByTimeAsync(2500)
    const release = await acquisition
    expect(fixture.executeJavaScript).toHaveBeenCalledTimes(1)
    release()
    expect(fixture.executeJavaScript.mock.calls.at(-1)?.[0]).toContain(
      `bridge.release("${fixture.proof.token}")`
    )
  })

  it('bounds a hung acquisition and cleans up a late readiness proof', async () => {
    vi.useFakeTimers()
    const fixture = clientFixture()
    let finish!: (result: unknown) => void
    fixture.executeJavaScript.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const rejected = expect(
      browserManager.acquireAutomationVisibility(fixture.guest.id)
    ).rejects.toMatchObject({ code: 'browser_client_page_automation_guest_not_ready' })
    await vi.advanceTimersByTimeAsync(5000)
    await rejected
    finish(fixture.proof)
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.executeJavaScript.mock.calls.at(-1)?.[0]).toContain(
      `bridge.release("${fixture.proof.token}")`
    )
  })

  it('passes caller-owned emulation without changing it, and releases a valid lease once', async () => {
    const fixture = clientFixture()
    const override = {
      width: 375,
      height: 812,
      deviceScaleFactor: 2,
      mobile: true
    }
    await expect(
      browserManager.setViewportOverride(fixture.identity.browserPageId, override)
    ).resolves.toBe(true)
    const writesBeforeAcquire = fixture.guest.debugger.sendCommand.mock.calls.length
    const release = await browserManager.acquireAutomationVisibility(fixture.guest.id)
    expect(fixture.executeJavaScript.mock.calls[0]?.[0]).toContain(
      '"viewportOverride":{"width":375,"height":812,"deviceScaleFactor":2,"mobile":true}'
    )
    release()
    release()
    expect(fixture.executeJavaScript).toHaveBeenCalledTimes(2)
    expect(fixture.guest.debugger.sendCommand).toHaveBeenCalledTimes(writesBeforeAcquire)
    await expect(
      browserManager.setViewportOverride(fixture.identity.browserPageId, null)
    ).resolves.toBe(true)
    await browserManager.acquireAutomationVisibility(fixture.guest.id)
    expect(fixture.executeJavaScript.mock.calls.at(-1)?.[0]).toContain('"viewportOverride":null')
  })

  it('tracks the applied metrics even when a later emulation command fails', async () => {
    const fixture = clientFixture()
    fixture.guest.debugger.sendCommand.mockImplementation(async (method) => {
      if (method === 'Emulation.setTouchEmulationEnabled') {
        throw new Error('touch command failed')
      }
    })
    await expect(
      browserManager.setViewportOverride(fixture.identity.browserPageId, {
        width: 375,
        height: 812,
        deviceScaleFactor: 2,
        mobile: true
      })
    ).resolves.toBe(false)
    const release = await browserManager.acquireAutomationVisibility(fixture.guest.id)
    expect(fixture.executeJavaScript.mock.calls[0]?.[0]).toContain(
      '"viewportOverride":{"width":375,"height":812'
    )
    release()

    await expect(
      browserManager.setViewportOverride(fixture.identity.browserPageId, null)
    ).resolves.toBe(false)
    await browserManager.acquireAutomationVisibility(fixture.guest.id)
    expect(fixture.executeJavaScript.mock.calls.at(-1)?.[0]).toContain('"viewportOverride":null')
  })

  it.each([null, { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false }])(
    'disables touch emulation with protocol-valid parameters for %j',
    async (override) => {
      const fixture = clientFixture()
      fixture.guest.debugger.sendCommand.mockImplementation(
        async (method, params?: { maxTouchPoints?: number }) => {
          if (
            method === 'Emulation.setTouchEmulationEnabled' &&
            params?.maxTouchPoints !== undefined &&
            params.maxTouchPoints < 1
          ) {
            throw new Error('Touch points must be between 1 and 16')
          }
        }
      )
      await expect(
        browserManager.setViewportOverride(fixture.identity.browserPageId, override)
      ).resolves.toBe(true)
    }
  )

  it('preserves the no-renderer path for ordinary headless guests', async () => {
    await expect(browserManager.acquireAutomationVisibility(999999)).resolves.toBeTypeOf('function')
  })
})
