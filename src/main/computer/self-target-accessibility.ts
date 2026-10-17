import { RuntimeClientError } from './runtime-client-error'

/** Bundle ids this app ships under, including per-worktree dev wrappers. */
const SELF_BUNDLE_ID_PREFIXES = ['com.omniconsole.ide', 'com.stablyai.omni']
/**
 * The segment that tells the dev copy's bundle ids from the packaged app's.
 *
 * Why it matters: the two install side by side on purpose (their single-instance locks
 * are namespaced), and each resolves the OTHER by bundle id. Accepting a sibling's id
 * as "us" enables accessibility and raises the window in the wrong process, which the
 * caller can never repair by retrying — it only ever gets a refusal for the app it
 * actually addressed.
 */
const DEV_BUNDLE_ID_SEGMENT = 'dev'
/** Suffix `app.getName()` carries in the dev copy (src/main/startup/dev-instance-identity.ts). */
const DEV_APP_NAME_SUFFIX = ' dev'
const DEFAULT_FOCUS_TIMEOUT_MS = 2_000
const DEFAULT_SESSION_IDLE_MS = 10 * 60_000

export type SelfTargetWindowHost = {
  isDestroyed: () => boolean
  isFocused: () => boolean
  /** Bring the app window forward (restore first when minimized). */
  focus: () => void
  /** Subscribe to the window `focus` event; returns an unsubscribe. */
  onceFocused: (listener: () => void) => () => void
}

export type SelfTargetAccessibilityHost = {
  appName: () => string
  pid: number
  isAccessibilitySupportEnabled: () => boolean
  setAccessibilitySupportEnabled: (enabled: boolean) => void
  window: SelfTargetWindowHost
  log: (message: string) => void
  setTimer?: (handler: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
  focusTimeoutMs?: number
  sessionIdleMs?: number
}

let host: SelfTargetAccessibilityHost | null = null
let enabledForSelfTarget = false
let sessionIdleTimer: unknown = null

export function registerSelfTargetAccessibilityHost(next: SelfTargetAccessibilityHost): () => void {
  host = next
  return () => {
    if (host === next) {
      releaseSelfTargetAccessibilitySupport()
      host = null
    }
  }
}

export function resetSelfTargetAccessibilityForTest(): void {
  clearSessionIdleTimer()
  host = null
  enabledForSelfTarget = false
}

/**
 * Whether this process is the Electron app that owns a window. Only then can a
 * chrome-only tree be blamed on Electron withholding the renderer tree: the headless
 * runtime host has no renderer of its own to expose.
 */
export function selfTargetAccessibilityActive(): boolean {
  return host !== null
}

/** True when this computer-use request targets our own app rather than a foreign one. */
export function isSelfTargetedComputerApp(selector: string | undefined): boolean {
  if (!host || typeof selector !== 'string') {
    return false
  }
  const value = selector.trim().toLowerCase()
  if (!value) {
    return false
  }
  if (value.startsWith('pid:')) {
    return Number(value.slice(4)) === host.pid
  }
  if (SELF_BUNDLE_ID_PREFIXES.some((id) => value === id || value.startsWith(`${id}.`))) {
    // One of this app's ids — but the dev copy and the packaged app are two processes,
    // and each must only answer for its own side.
    return namesDevBundleId(value) === hostIsDevInstance(host)
  }
  return value === host.appName().trim().toLowerCase()
}

function namesDevBundleId(value: string): boolean {
  return SELF_BUNDLE_ID_PREFIXES.some(
    (id) =>
      value === `${id}.${DEV_BUNDLE_ID_SEGMENT}` ||
      value.startsWith(`${id}.${DEV_BUNDLE_ID_SEGMENT}.`)
  )
}

function hostIsDevInstance(active: SelfTargetAccessibilityHost): boolean {
  return active.appName().trim().toLowerCase().endsWith(DEV_APP_NAME_SUFFIX)
}

/**
 * Self-targeted requests need Electron to publish its renderer accessibility tree and,
 * for input, focus resolved through the app itself: the OS-level "focused window" reading
 * reports none for an Electron window that is verifiably frontmost.
 */
export async function prepareSelfTargetedComputerRequest(
  selector: string | undefined,
  options: { requireFocus: boolean }
): Promise<boolean> {
  if (!isSelfTargetedComputerApp(selector)) {
    return false
  }
  const active = host!
  enableAccessibilitySupport(active)
  if (options.requireFocus) {
    await resolveSelfTargetFocus(active)
  }
  return true
}

/**
 * Publish the renderer tree for a snapshot that IS this app but did not NAME it the way
 * a selector is recognised: on Windows and Linux the app name the tool itself lists
 * ('Orca', the executable name) resolves this very window while matching no selector
 * form. The snapshot's own pid is the proof, so the caller decides and this only acts.
 *
 * Returns whether the tree is published now, so the refusal can say what was actually
 * done instead of claiming an enable that never happened.
 */
export function enableSelfTargetAccessibility(): boolean {
  if (!host) {
    return false
  }
  return enableAccessibilitySupport(host)
}

/** True when accessibility support is on for this process after this call. */
function enableAccessibilitySupport(active: SelfTargetAccessibilityHost): boolean {
  scheduleSessionIdleRelease(active)
  if (enabledForSelfTarget || active.isAccessibilitySupportEnabled()) {
    return true
  }
  active.setAccessibilitySupportEnabled(true)
  enabledForSelfTarget = true
  active.log('enabled accessibility support for a self-targeted computer-use request')
  return true
}

async function resolveSelfTargetFocus(active: SelfTargetAccessibilityHost): Promise<void> {
  const window = active.window
  if (window.isDestroyed()) {
    throw new RuntimeClientError(
      'window_not_focused',
      'the OmniConsole window is gone; open the app window before driving OmniConsole itself'
    )
  }
  if (window.isFocused()) {
    return
  }
  window.focus()
  await waitForWindowFocus(active)
  if (!window.isFocused()) {
    throw new RuntimeClientError(
      'window_not_focused',
      'OmniConsole did not take keyboard focus for a self-targeted action; BrowserWindow.isFocused() stayed false after focus(), so bring the app forward manually and retry'
    )
  }
}

function waitForWindowFocus(active: SelfTargetAccessibilityHost): Promise<void> {
  const setTimer = active.setTimer ?? ((handler, ms) => setTimeout(handler, ms))
  const clearTimer = active.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout))
  return new Promise((resolve) => {
    // Why the late bindings: a host may deliver the focus event synchronously, before the
    // subscription and timer handles exist.
    let settled = false
    let unsubscribe: (() => void) | null = null
    let timer: unknown = null
    const settle = (): void => {
      if (settled) {
        return
      }
      settled = true
      unsubscribe?.()
      if (timer !== null) {
        clearTimer(timer)
      }
      resolve()
    }
    unsubscribe = active.window.onceFocused(settle)
    if (settled) {
      unsubscribe()
      return
    }
    timer = setTimer(settle, active.focusTimeoutMs ?? DEFAULT_FOCUS_TIMEOUT_MS)
    if (active.window.isFocused()) {
      settle()
    }
  })
}

// Why: the accessibility tree costs renderer work, so keep it on only while self-targeting
// requests keep arriving, and only turn it back off when this app turned it on.
function scheduleSessionIdleRelease(active: SelfTargetAccessibilityHost): void {
  clearSessionIdleTimer()
  const setTimer = active.setTimer ?? ((handler, ms) => setTimeout(handler, ms))
  sessionIdleTimer = setTimer(() => {
    sessionIdleTimer = null
    releaseSelfTargetAccessibilitySupport()
  }, active.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS)
}

function releaseSelfTargetAccessibilitySupport(): void {
  clearSessionIdleTimer()
  if (!host || !enabledForSelfTarget) {
    return
  }
  enabledForSelfTarget = false
  host.setAccessibilitySupportEnabled(false)
  host.log('released accessibility support after the self-targeted computer-use session went idle')
}

function clearSessionIdleTimer(): void {
  const timer = sessionIdleTimer
  sessionIdleTimer = null
  if (timer === null || timer === undefined) {
    return
  }
  const clearTimer = host?.clearTimer ?? ((value: unknown) => clearTimeout(value as NodeJS.Timeout))
  clearTimer(timer)
}
