import type { BrowserClientAutomationVisibilityRequest } from '../../../../../shared/browser-client-automation-visibility'
import { readBrowserClientRetainedViewport } from '../browser-client-page-renderer-installation'
import { readBrowserClientPageAttachedGuestId } from '../browser-client-page-retained-elements'

const READY_TIMEOUT_MS = 2_000
const VIEWPORT_SCRIPT = `({
  width: window.innerWidth,
  height: window.innerHeight,
  screenWidth: window.screen.width,
  screenHeight: window.screen.height
})`

function positiveSize(width: number, height: number): boolean {
  return Number.isFinite(width) && Number.isFinite(height) && width > 1 && height > 1
}

function sameSize(actual: number, expected: number): boolean {
  return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= 2
}

async function isReady(expected: BrowserClientAutomationVisibilityRequest): Promise<boolean> {
  const page = readBrowserClientRetainedViewport(expected)
  if (
    !page ||
    page.status !== 'attached' ||
    page.webContentsId !== expected.webContentsId ||
    readBrowserClientPageAttachedGuestId(page.webview) !== expected.webContentsId ||
    !page.container?.isConnected ||
    !page.host.isConnected ||
    !page.webview.isConnected
  ) {
    return false
  }
  const content = page.container.getBoundingClientRect()
  const host = page.host.getBoundingClientRect()
  const guest = page.webview.getBoundingClientRect()
  if (
    !positiveSize(content.width, content.height) ||
    !positiveSize(host.width, host.height) ||
    !positiveSize(guest.width, guest.height) ||
    !sameSize(host.width, content.width) ||
    !sameSize(host.height, content.height) ||
    !sameSize(guest.width, host.width) ||
    !sameSize(guest.height, host.height)
  ) {
    return false
  }
  const viewport = (await page.webview.executeJavaScript(VIEWPORT_SCRIPT)) as {
    width: number
    height: number
    screenWidth: number
    screenHeight: number
  } | null
  if (!viewport || !positiveSize(viewport.width, viewport.height)) {
    return false
  }
  const current = readBrowserClientRetainedViewport(expected)
  if (
    current?.status !== 'attached' ||
    current.webContentsId !== expected.webContentsId ||
    current.webview !== page.webview ||
    current.host !== page.host ||
    current.container !== page.container ||
    !page.container.isConnected ||
    !page.host.isConnected ||
    readBrowserClientPageAttachedGuestId(page.webview) !== expected.webContentsId
  ) {
    return false
  }
  const latest = page.container.getBoundingClientRect()
  if (!sameSize(latest.width, content.width) || !sameSize(latest.height, content.height)) {
    return false
  }
  if (expected.viewportOverride) {
    const override = expected.viewportOverride
    if (!override.mobile) {
      // Desktop emulation changes the layout viewport, leaving the physical screen unchanged.
      const zoom = page.webview.getZoomFactor()
      return (
        sameSize(viewport.width, override.width / zoom) &&
        sameSize(viewport.height, override.height / zoom)
      )
    }
    // Mobile layout can exceed the emulated screen when a page has no viewport meta tag.
    return (
      sameSize(viewport.screenWidth, override.width) &&
      sameSize(viewport.screenHeight, override.height)
    )
  }
  const zoom = expected.embedderZoomFactor / page.webview.getZoomFactor()
  return (
    sameSize(viewport.width, content.width * zoom) &&
    sameSize(viewport.height, content.height * zoom)
  )
}

export function waitForBrowserClientAutomationReady(
  expected: BrowserClientAutomationVisibilityRequest
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let frame: number | null = null
    let fallback: ReturnType<typeof setTimeout> | null = null
    const finish = (ready: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(deadline)
      if (frame !== null) {
        window.cancelAnimationFrame?.(frame)
      }
      if (fallback !== null) {
        clearTimeout(fallback)
      }
      resolve(ready)
    }
    const deadline = setTimeout(() => finish(false), READY_TIMEOUT_MS)
    const probe = async (): Promise<void> => {
      frame = null
      fallback = null
      if (settled) {
        return
      }
      const ready = await isReady(expected).catch(() => false)
      if (settled) {
        return
      }
      if (ready) {
        finish(true)
      } else if (typeof window.requestAnimationFrame === 'function') {
        frame = window.requestAnimationFrame(() => void probe())
      } else {
        fallback = setTimeout(() => void probe(), 16)
      }
    }
    void probe()
  })
}
