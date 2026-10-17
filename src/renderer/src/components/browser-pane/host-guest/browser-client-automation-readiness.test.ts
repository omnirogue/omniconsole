// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserClientAutomationVisibilityRequest } from '../../../../../shared/browser-client-automation-visibility'
import { installBrowserClientPageRenderer } from '../browser-client-page-renderer-installation'
import {
  createRetainedHostFixture,
  disposeRetainedHostFixtures,
  RETAINED_FIXTURE_PAGE as PAGE
} from '../browser-client-page-retained-host-fixture'
import {
  installBrowserAutomationVisibilityBridge,
  isBrowserAutomationVisible,
  releaseBrowserAutomationVisibility
} from './browser-automation-visibility'

const disposers: (() => void)[] = []
const tokens: string[] = []

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) =>
    window.setTimeout(() => callback(0), 16)
  )
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => window.clearTimeout(id))
  installBrowserAutomationVisibilityBridge()
})
afterEach(() => {
  for (const token of tokens.splice(0)) {
    releaseBrowserAutomationVisibility(token)
  }
  for (const dispose of disposers.splice(0)) {
    dispose()
  }
  disposeRetainedHostFixtures()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function fixture() {
  const retained = createRetainedHostFixture()
  await retained.mount()
  const installation = installBrowserClientPageRenderer({
    registry: retained.registry,
    subscribe: () => () => {}
  })!
  disposers.push(() => installation.dispose())
  const page = retained.registry.getPage(PAGE)!
  const size = { width: 640, height: 480 }
  const metrics = { width: 640, height: 480, screenWidth: 1920, screenHeight: 1080 }
  vi.spyOn(retained.container, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(20, 30, size.width, size.height)
  )
  vi.spyOn(page.host, 'getBoundingClientRect').mockImplementation(
    () =>
      new DOMRect(
        20,
        30,
        Number.parseFloat(page.host.style.width),
        Number.parseFloat(page.host.style.height)
      )
  )
  vi.spyOn(page.webview, 'getBoundingClientRect').mockImplementation(() =>
    page.host.getBoundingClientRect()
  )
  const executeJavaScript = vi.fn(async () => ({ ...metrics }))
  Object.assign(page.webview, { executeJavaScript, getZoomFactor: vi.fn(() => 1) })
  const expected: BrowserClientAutomationVisibilityRequest = {
    browserPageId: PAGE.browserPageId,
    pageHostGeneration: PAGE.pageHostGeneration,
    webContentsId: page.webContentsId!,
    viewportOverride: null,
    embedderZoomFactor: 1
  }
  const acquire = async (request = expected) => {
    const result = await window.__orcaBrowserAutomationVisibility!.acquire(
      PAGE.browserPageId,
      request
    )
    if (result) {
      tokens.push(result.token)
    }
    return result
  }
  return { ...retained, page, size, metrics, executeJavaScript, expected, acquire }
}

describe('retained client guest readiness', () => {
  it('waits for the exact attached guest to receive the measured content size', async () => {
    const f = await fixture()
    const parent = f.page.webview.parentElement
    f.metrics.width = 1
    f.metrics.height = 1
    let completed = false
    const acquisition = f.acquire().then((result) => {
      completed = true
      return result
    })
    await vi.advanceTimersByTimeAsync(16)
    expect(completed).toBe(false)
    expect(isBrowserAutomationVisible(PAGE.browserPageId)).toBe(true)
    const owner = f.registry.attachPage(PAGE, f.container, false)
    await vi.advanceTimersByTimeAsync(16)
    expect(completed).toBe(false)
    Object.assign(f.metrics, f.size)
    await vi.advanceTimersByTimeAsync(16)
    expect(await acquisition).toMatchObject({
      browserPageId: PAGE.browserPageId,
      pageHostGeneration: PAGE.pageHostGeneration,
      webContentsId: f.page.webContentsId
    })
    expect(f.page.webview.parentElement).toBe(parent)
    expect(f.host().inert).toBe(true)
    expect(f.host().getAttribute('aria-hidden')).toBe('true')
    expect(f.host().style.opacity).toBe('0')
    expect(f.host().style.pointerEvents).toBe('none')
    owner.detach()
    expect(f.host().style.width).toBe('1px')
  })

  it('shares automation ownership and lets a newly visible owner keep the live viewport', async () => {
    const f = await fixture()
    const first = f.registry.attachPage(PAGE, f.container, false)
    const second = f.registry.attachPage(PAGE, f.container, false)
    const visible = f.registry.attachPage(PAGE, f.container, true)
    expect(f.host().inert).toBe(false)
    expect(f.host().style.opacity).toBe('1')
    first.detach()
    f.size.width = 900
    await vi.advanceTimersByTimeAsync(16)
    second.detach()
    expect(f.host().style.width).toBe('900px')
    expect(f.host().style.pointerEvents).toBe('auto')
    visible.detach()
    expect(f.host().style.width).toBe('1px')
    expect(f.host().inert).toBe(true)
  })

  it('refuses a parked host even if existing emulation gives its guest a large viewport', async () => {
    const f = await fixture()
    Object.assign(f.metrics, { width: 980, height: 2122, screenWidth: 375, screenHeight: 812 })
    const acquisition = f.acquire({
      ...f.expected,
      viewportOverride: { width: 375, height: 812, deviceScaleFactor: 2, mobile: true }
    })
    await vi.advanceTimersByTimeAsync(2000)
    expect(await acquisition).toBeNull()
    expect(isBrowserAutomationVisible(PAGE.browserPageId)).toBe(false)
    expect(f.executeJavaScript).not.toHaveBeenCalled()
  })

  it.each(['rekey', 'retire', 'native replacement'] as const)(
    'refuses %s during a pending guest read',
    async (change) => {
      const f = await fixture()
      f.registry.attachPage(PAGE, f.container, false)
      let finish!: (value: typeof f.metrics) => void
      f.executeJavaScript.mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve
        })
      )
      const acquisition = f.acquire()
      await Promise.resolve()
      if (change === 'rekey') {
        f.registry.rekeyPage(PAGE, { ...PAGE, pageHostGeneration: PAGE.pageHostGeneration + 1 })
      } else if (change === 'retire') {
        f.registry.retirePage(PAGE)
      } else {
        f.page.webview.dataset.webContentsId = '999'
      }
      finish({ ...f.metrics })
      await vi.advanceTimersByTimeAsync(2000)
      expect(await acquisition).toBeNull()
      expect(isBrowserAutomationVisible(PAGE.browserPageId)).toBe(false)
    }
  )

  it.each([1, 1.5])(
    'accepts desktop emulation at guest zoom %s with the physical screen unchanged',
    async (zoom) => {
      const f = await fixture()
      f.registry.attachPage(PAGE, f.container, false)
      Object.assign(f.page.webview, { getZoomFactor: () => zoom })
      Object.assign(f.metrics, { width: Math.floor(1024 / zoom), height: Math.floor(768 / zoom) })
      expect(
        await f.acquire({
          ...f.expected,
          viewportOverride: { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false }
        })
      ).not.toBeNull()
    }
  )

  it('waits for the desktop layout even when the physical screen matches the override', async () => {
    const f = await fixture()
    f.registry.attachPage(PAGE, f.container, false)
    Object.assign(f.metrics, { screenWidth: 1024, screenHeight: 768 })
    let completed = false
    const acquisition = f
      .acquire({
        ...f.expected,
        viewportOverride: { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false }
      })
      .then((result) => {
        completed = true
        return result
      })
    await vi.advanceTimersByTimeAsync(16)
    expect(completed).toBe(false)
    Object.assign(f.metrics, { width: 1024, height: 768 })
    await vi.advanceTimersByTimeAsync(16)
    expect(await acquisition).not.toBeNull()
  })

  it('accepts caller mobile emulation and later waits for fresh implicit dimensions', async () => {
    const f = await fixture()
    f.registry.attachPage(PAGE, f.container, false)
    Object.assign(f.metrics, { width: 980, height: 2122, screenWidth: 375, screenHeight: 812 })
    expect(
      await f.acquire({
        ...f.expected,
        viewportOverride: { width: 375, height: 812, deviceScaleFactor: 2, mobile: true }
      })
    ).not.toBeNull()
    f.size.width = 900
    let completed = false
    const acquisition = f.acquire().then((result) => {
      completed = true
      return result
    })
    await vi.advanceTimersByTimeAsync(16)
    expect(completed).toBe(false)
    Object.assign(f.metrics, f.size)
    await vi.advanceTimersByTimeAsync(16)
    expect(await acquisition).not.toBeNull()
    expect(f.host().style.width).toBe('900px')
  })

  it('accounts for independent embedder and guest page zoom', async () => {
    const f = await fixture()
    f.registry.attachPage(PAGE, f.container, false)
    Object.assign(f.page.webview, { getZoomFactor: () => 1.5 })
    Object.assign(f.metrics, { width: 512, height: 384 })
    expect(await f.acquire({ ...f.expected, embedderZoomFactor: 1.2 })).not.toBeNull()
  })

  it('bounds a guest read that never answers and removes the lease', async () => {
    const f = await fixture()
    f.registry.attachPage(PAGE, f.container, false)
    f.executeJavaScript.mockReturnValueOnce(new Promise(() => {}))
    const acquisition = f.acquire()
    await vi.advanceTimersByTimeAsync(2000)
    expect(await acquisition).toBeNull()
    expect(isBrowserAutomationVisible(PAGE.browserPageId)).toBe(false)
  })
})
