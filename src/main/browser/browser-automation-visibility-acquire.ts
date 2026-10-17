import type {
  BrowserClientAutomationVisibilityReady,
  BrowserClientAutomationVisibilityRequest
} from '../../shared/browser-client-automation-visibility'
import { BrowserClientPageCommandError } from './browser-client-page-command-failure'

// The renderer has its own two-second readiness window after IPC delivery.
const ACQUIRE_TIMEOUT_MS = 5_000

function readToken(result: unknown): string | null {
  const token = result && typeof result === 'object' && 'token' in result ? result.token : result
  return typeof token === 'string' && token.length > 0 ? token : null
}

function releaseToken(renderer: Electron.WebContents, token: string): void {
  if (renderer.isDestroyed()) {
    return
  }
  try {
    renderer
      .executeJavaScript(`(() => {
        const bridge = window.__orcaBrowserAutomationVisibility;
        if (!bridge || typeof bridge.release !== 'function') return false;
        return bridge.release(${JSON.stringify(token)});
      })()`)
      .catch(() => {})
  } catch {}
}

export function clientAutomationGuestNotReady(): BrowserClientPageCommandError {
  return new BrowserClientPageCommandError('browser_client_page_automation_guest_not_ready')
}

function requestVisibility(renderer: Electron.WebContents, args: string): Promise<unknown> {
  try {
    return renderer
      .executeJavaScript(`(async function() {
      var bridge = window.__orcaBrowserAutomationVisibility;
      if (!bridge || typeof bridge.acquire !== 'function') return null;
      return await bridge.acquire(${args});
    })()`)
      .catch(() => null)
  } catch {
    return Promise.resolve(null)
  }
}

export async function acquireRendererAutomationVisibility(
  renderer: Electron.WebContents,
  browserPageId: string,
  expected?: BrowserClientAutomationVisibilityRequest,
  isCurrent: () => boolean = () => true
): Promise<() => void> {
  const args = expected
    ? `${JSON.stringify(browserPageId)}, ${JSON.stringify(expected)}`
    : JSON.stringify(browserPageId)
  const acquire = requestVisibility(renderer, args)
  let timeout: ReturnType<typeof setTimeout> | undefined
  const expired = Symbol('expired')
  const result = await Promise.race([
    acquire,
    new Promise<typeof expired>((resolve) => {
      timeout = setTimeout(() => resolve(expired), ACQUIRE_TIMEOUT_MS)
    })
  ]).finally(() => clearTimeout(timeout))
  if (result === expired) {
    // The renderer can finish after main's deadline; its lease still needs a release.
    void acquire.then((late) => {
      const token = readToken(late)
      if (token) {
        releaseToken(renderer, token)
      }
    })
  }
  const token = readToken(result)
  if (expected) {
    const ready = result as Partial<BrowserClientAutomationVisibilityReady> | null
    if (
      !token ||
      !ready ||
      typeof ready !== 'object' ||
      ready.browserPageId !== expected.browserPageId ||
      ready.pageHostGeneration !== expected.pageHostGeneration ||
      ready.webContentsId !== expected.webContentsId ||
      renderer.isDestroyed() ||
      !isCurrent()
    ) {
      if (token) {
        releaseToken(renderer, token)
      }
      throw clientAutomationGuestNotReady()
    }
  }
  if (!token) {
    return () => {}
  }
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    releaseToken(renderer, token)
  }
}
