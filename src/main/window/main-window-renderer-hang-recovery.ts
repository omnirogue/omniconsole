import type { BrowserWindow } from 'electron'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'

// Why: Chromium reports 'unresponsive' only after input goes unacked, so the user has already waited; this is the extra grace before recovery.
export const RENDERER_HANG_RECOVERY_GRACE_MS = 30_000
export const RENDERER_HANG_RECOVERY_WINDOW_MS = 10 * 60_000
export const RENDERER_HANG_RECOVERY_MAX_PER_WINDOW = 2
const STACK_CAPTURE_TIMEOUT_MS = 5_000
const STACK_FRAME_LIMIT = 25

type DebuggerLike = Pick<
  Electron.Debugger,
  'attach' | 'detach' | 'isAttached' | 'on' | 'removeListener' | 'sendCommand'
>

export type RendererHangWindow = {
  isDestroyed: () => boolean
  on: (event: 'unresponsive' | 'responsive', listener: () => void) => unknown
  webContents: {
    debugger: DebuggerLike
    forcefullyCrashRenderer: () => void
    isDestroyed: () => boolean
  }
}

type PausedCallFrame = {
  functionName?: string
  url?: string
  location?: { lineNumber?: number; columnNumber?: number }
}

export type RendererHangRecovery = { dispose: () => void }

function formatFrame(frame: PausedCallFrame): string {
  const file = (frame.url ?? '').split(/[\\/]/).pop() || '<anonymous>'
  const line = (frame.location?.lineNumber ?? 0) + 1
  const column = (frame.location?.columnNumber ?? 0) + 1
  return `${frame.functionName || '<anonymous>'} (${file}:${line}:${column})`
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

// Why: a busy renderer still services DevTools interrupts, so a pause shows the JS loop that a native sample cannot.
export async function captureHungRendererStack(
  dbg: DebuggerLike,
  timeoutMs = STACK_CAPTURE_TIMEOUT_MS
): Promise<string> {
  if (dbg.isAttached()) {
    return 'unavailable: debugger already attached'
  }
  dbg.attach('1.3')
  let onMessage: ((event: Electron.Event, method: string, params: unknown) => void) | null = null
  try {
    const paused = new Promise<PausedCallFrame[]>((resolve) => {
      onMessage = (_event, method, params) => {
        if (method === 'Debugger.paused') {
          resolve((params as { callFrames?: PausedCallFrame[] })?.callFrames ?? [])
        }
      }
      dbg.on('message', onMessage)
    })
    await withTimeout(dbg.sendCommand('Debugger.enable'), timeoutMs)
    await withTimeout(dbg.sendCommand('Debugger.pause'), timeoutMs)
    const frames = await withTimeout(paused, timeoutMs)
    await dbg.sendCommand('Debugger.resume').catch(() => undefined)
    return frames.slice(0, STACK_FRAME_LIMIT).map(formatFrame).join('\n') || 'empty'
  } finally {
    if (onMessage) {
      dbg.removeListener('message', onMessage)
    }
    try {
      dbg.detach()
    } catch {
      // already detached by the renderer's death
    }
  }
}

export function installMainWindowRendererHangRecovery(args: {
  mainWindow: RendererHangWindow | BrowserWindow
  shouldSkipRecovery: () => boolean
  graceMs?: number
  now?: () => number
  record?: typeof recordDurableCrashBreadcrumb
}): RendererHangRecovery {
  const mainWindow = args.mainWindow as RendererHangWindow
  const graceMs = args.graceMs ?? RENDERER_HANG_RECOVERY_GRACE_MS
  const now = args.now ?? Date.now
  const record = args.record ?? recordDurableCrashBreadcrumb
  let hangStartedAt: number | null = null
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null
  let recoveries: number[] = []
  let disposed = false

  const clearRecoveryTimer = (): void => {
    if (recoveryTimer) {
      clearTimeout(recoveryTimer)
      recoveryTimer = null
    }
  }
  const windowGone = (): boolean => mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()

  const recover = (): void => {
    recoveryTimer = null
    if (hangStartedAt === null || windowGone() || args.shouldSkipRecovery()) {
      return
    }
    const at = now()
    recoveries = recoveries.filter((t) => at - t < RENDERER_HANG_RECOVERY_WINDOW_MS)
    const unresponsiveMs = at - hangStartedAt
    if (recoveries.length >= RENDERER_HANG_RECOVERY_MAX_PER_WINDOW) {
      // Why: a hang on every load would otherwise reload forever; leave View > Force Reload to the person.
      record('renderer_hang_recovery_suppressed', {
        unresponsiveMs,
        recentRecoveries: recoveries.length
      })
      return
    }
    recoveries.push(at)
    // Why: the replacement renderer never reports 'responsive', so its own later hang must start a fresh episode.
    hangStartedAt = null
    record('renderer_hang_recovery', { unresponsiveMs })
    // Why: render-process-gone then runs the existing breaker-guarded reload; PTYs live outside the renderer.
    mainWindow.webContents.forcefullyCrashRenderer()
  }

  const onUnresponsive = (): void => {
    if (hangStartedAt !== null || windowGone()) {
      return
    }
    hangStartedAt = now()
    record('renderer_unresponsive', {})
    void captureHungRendererStack(mainWindow.webContents.debugger).then(
      (stack) => record('renderer_hang_stack', { stack }),
      (error: unknown) =>
        record('renderer_hang_stack', {
          stack: `unavailable: ${error instanceof Error ? error.message : String(error)}`
        })
    )
    recoveryTimer = setTimeout(recover, graceMs)
  }

  const onResponsive = (): void => {
    if (hangStartedAt === null) {
      return
    }
    record('renderer_responsive_again', { unresponsiveMs: now() - hangStartedAt })
    hangStartedAt = null
    clearRecoveryTimer()
  }

  mainWindow.on('unresponsive', () => !disposed && onUnresponsive())
  mainWindow.on('responsive', () => !disposed && onResponsive())
  return {
    // Why: runs from 'closed', where the window's listeners die with it; only the timer outlives it.
    dispose: () => {
      disposed = true
      clearRecoveryTimer()
    }
  }
}
