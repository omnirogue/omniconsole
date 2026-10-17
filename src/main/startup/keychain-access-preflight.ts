import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, Notification, safeStorage } from 'electron'
import { translateMain } from '../i18n/main-i18n'
import { runProcessSync } from '../../shared/child-process/run-process'

/**
 * Make the first Keychain read of a new build visible instead of a silent freeze.
 *
 * Why: an ad-hoc signed build gets a new code hash on every install, and the Keychain grant on
 * the safe-storage key is pinned to the old hash. The first `safeStorage` call of the new build
 * (the store decrypting saved secrets, before any window exists) then blocks the main thread on
 * a SecurityAgent prompt that macOS does not bring forward. On 5 Oct 2026 that prompt sat behind
 * other windows from 10:04:18 to 10:14:37 while the app showed nothing — "frozen at load".
 *
 * So, once per build: put a window (desktop) or a banner (headless serve) in front that says
 * what macOS is asking, bounce the Dock, and only then touch the Keychain. A build whose grant
 * already holds — or one with a stable signing identity, whose grant survives updates — skips
 * all of this.
 */

const MARKER_FILE = 'keychain-access-preflight.json'
// Why a bound on the wait for the notice to paint: `ready-to-show` can fail to fire when the GPU
// cannot present (see main-window-state-lifecycle). The probe must still run, just unannounced.
const NOTICE_PAINT_TIMEOUT_MS = 3_000
// Why: one compositor frame after `ready-to-show` so the window is on screen before the
// main thread blocks.
const NOTICE_PRESENT_DELAY_MS = 120
// A probe slower than this was waiting on a person, not on the Keychain.
const ANSWERED_PROMPT_MS = 1_500

export type KeychainPreflightMarker = {
  version: 1
  fingerprint: string
  grantHeld: boolean
}

export type SignatureKind = 'adhoc' | 'stable' | 'unknown'

/** Changes whenever the installed main executable (and so its embedded signature) changes. */
export function executableFingerprint(
  execPath: string,
  appVersion: string,
  stat: (path: string) => { ino: number; size: number; mtimeMs: number } = statSync
): string | null {
  try {
    const { ino, size, mtimeMs } = stat(execPath)
    return `${appVersion}:${ino}:${size}:${Math.round(mtimeMs)}`
  } catch {
    return null
  }
}

export function parseKeychainPreflightMarker(raw: string): KeychainPreflightMarker | null {
  try {
    const value = JSON.parse(raw) as Partial<KeychainPreflightMarker>
    if (
      value?.version === 1 &&
      typeof value.fingerprint === 'string' &&
      typeof value.grantHeld === 'boolean'
    ) {
      return { version: 1, fingerprint: value.fingerprint, grantHeld: value.grantHeld }
    }
  } catch {
    // A corrupt marker is the same as no marker: warn once more.
  }
  return null
}

export function parseSignatureKind(codesignOutput: string): SignatureKind {
  if (/^Signature=adhoc$/m.test(codesignOutput)) {
    return 'adhoc'
  }
  return /^Authority=/m.test(codesignOutput) ? 'stable' : 'unknown'
}

/** Whether this launch may hit a Keychain prompt nobody has been told about. */
export function keychainNoticeNeeded(
  marker: KeychainPreflightMarker | null,
  fingerprint: string
): boolean {
  return !marker || marker.fingerprint !== fingerprint || !marker.grantHeld
}

/**
 * Why a fast probe is the only proof of a lasting grant: "Allow" (as opposed to "Always Allow")
 * answers this launch only, so a probe that waited on a person says nothing about the next one.
 */
export function grantHeldAfterProbe(available: boolean, waitedMs: number): boolean {
  return available && waitedMs < ANSWERED_PROMPT_MS
}

export function appBundlePath(execPath: string): string | null {
  const marker = '.app/Contents/MacOS/'
  const index = execPath.indexOf(marker)
  return index === -1 ? null : execPath.slice(0, index + '.app'.length)
}

function readSignatureKind(bundlePath: string): SignatureKind {
  try {
    const result = runProcessSync({
      program: 'codesign',
      args: ['-dvv', bundlePath],
      timeoutMs: 5_000
    })
    return parseSignatureKind(`${result.stdout}\n${result.stderr}`)
  } catch {
    // Why: it throws only when codesign never started, which says nothing about the signature.
    return 'unknown'
  }
}

function readMarker(path: string): KeychainPreflightMarker | null {
  try {
    return parseKeychainPreflightMarker(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function writeMarker(path: string, marker: KeychainPreflightMarker): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(marker)}\n`, { mode: 0o600 })
  } catch (error) {
    console.warn('[keychain-preflight] could not record the probe result:', error)
  }
}

function noticeCopy(): { title: string; body: string; hint: string } {
  return {
    title: translateMain('startup.keychainNotice.title', 'Approve Keychain access to continue'),
    body: translateMain(
      'startup.keychainNotice.body',
      'This OmniConsole build is new, so macOS is asking before it unlocks your saved sign-ins. Choose “Always Allow” in the Keychain dialog and OmniConsole will finish starting.'
    ),
    hint: translateMain(
      'startup.keychainNotice.hint',
      'Can’t see the dialog? It may be behind other windows or on another desktop — press ⌘Tab or open Mission Control.'
    )
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
}

function noticeHtml(copy: { title: string; body: string; hint: string }): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1d1d1f;--muted:#6e6e73}
@media (prefers-color-scheme:dark){:root{--bg:#1e1e1e;--fg:#f5f5f7;--muted:#a1a1a6}}
body{margin:0;padding:24px 28px;background:var(--bg);color:var(--fg);font:13px/1.45 -apple-system,BlinkMacSystemFont,sans-serif;-webkit-user-select:none;cursor:default}
h1{font-size:15px;font-weight:600;margin:0 0 10px}p{margin:0 0 10px}.hint{color:var(--muted)}
</style></head><body><h1>${escapeHtml(copy.title)}</h1><p>${escapeHtml(copy.body)}</p><p class="hint">${escapeHtml(copy.hint)}</p></body></html>`
}

async function showDesktopNotice(): Promise<() => void> {
  const copy = noticeCopy()
  const window = new BrowserWindow({
    width: 460,
    height: 200,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    show: false,
    title: 'OmniConsole',
    webPreferences: {
      // Why its own in-memory partition: the default session's proxy guard holds every request
      // until the store has loaded the proxy settings, which is what this window runs ahead of.
      partition: 'omniconsole-keychain-notice',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false
    }
  })
  const close = (): void => {
    if (!window.isDestroyed()) {
      window.destroy()
    }
  }
  try {
    const painted = new Promise<void>((resolve) => {
      window.once('ready-to-show', () => resolve())
      setTimeout(resolve, NOTICE_PAINT_TIMEOUT_MS)
    })
    void window
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(noticeHtml(copy))}`)
      .catch(() => {})
    await painted
    if (!window.isDestroyed()) {
      window.show()
      app.focus({ steal: true })
      app.dock?.bounce('critical')
    }
    await new Promise((resolve) => setTimeout(resolve, NOTICE_PRESENT_DELAY_MS))
  } catch (error) {
    console.warn('[keychain-preflight] notice window failed:', error)
  }
  return close
}

function showHeadlessNotice(): () => void {
  const copy = noticeCopy()
  // Why both channels: serve has no window, and whoever is at this Mac is the only one who can
  // answer the prompt — paired computers just see a host that never comes up.
  console.warn(`[keychain-preflight] ${copy.title}. ${copy.body}`)
  if (!Notification.isSupported()) {
    return () => {}
  }
  try {
    const banner = new Notification({ title: copy.title, body: `${copy.body} ${copy.hint}` })
    banner.show()
    return () => banner.close()
  } catch {
    return () => {}
  }
}

/**
 * Decide, synchronously, whether this launch needs the announced Keychain probe. Returns null on
 * the common path (not macOS, unpackaged, or the grant is known to hold) so startup does not yield.
 * Must run before the store is constructed: loading it decrypts saved secrets.
 */
export function prepareKeychainAccessPreflight({
  userDataPath,
  headless
}: {
  userDataPath: string
  headless: boolean
}): (() => Promise<void>) | null {
  if (process.platform !== 'darwin' || !app.isPackaged) {
    return null
  }
  const fingerprint = executableFingerprint(process.execPath, app.getVersion())
  if (!fingerprint) {
    return null
  }
  const markerPath = join(userDataPath, MARKER_FILE)
  if (!keychainNoticeNeeded(readMarker(markerPath), fingerprint)) {
    return null
  }
  const bundlePath = appBundlePath(process.execPath)
  if (bundlePath && readSignatureKind(bundlePath) === 'stable') {
    // A certificate-signed build keeps its Keychain grant across updates; nothing to announce.
    writeMarker(markerPath, { version: 1, fingerprint, grantHeld: true })
    return null
  }
  return async () => {
    const dismiss = headless ? showHeadlessNotice() : await showDesktopNotice()
    const startedAt = Date.now()
    let available = false
    try {
      // Why encrypt rather than isEncryptionAvailable(): this is the call that has to fetch the
      // key, and once fetched it is cached for every later safeStorage call in this process.
      safeStorage.encryptString('omniconsole-keychain-preflight')
      available = true
    } catch (error) {
      console.warn('[keychain-preflight] Keychain unavailable:', error)
    }
    const waitedMs = Date.now() - startedAt
    dismiss()
    if (waitedMs >= ANSWERED_PROMPT_MS) {
      console.warn(`[keychain-preflight] waited ${waitedMs}ms for Keychain approval`)
    }
    writeMarker(markerPath, {
      version: 1,
      fingerprint,
      grantHeld: grantHeldAfterProbe(available, waitedMs)
    })
  }
}
