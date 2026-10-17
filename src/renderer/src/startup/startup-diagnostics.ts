type StartupDiagnosticDetails = Record<string, unknown>

const DEADLINE_REACHED = Symbol('startup-step-deadline')

function nowMs(): number {
  return Math.round(performance.now())
}

export function logRendererStartupDiagnostic(
  event: string,
  details: StartupDiagnosticDetails = {}
): void {
  const api = window.api?.app
  if (!api?.startupDiagnostic) {
    return
  }
  void api
    .startupDiagnostic(`renderer-${event}`, {
      rendererT: nowMs(),
      ...details
    })
    .catch(() => {
      // Diagnostics are best-effort and must never perturb startup behavior.
    })
}

export async function timeRendererStartupStep<T>(
  event: string,
  operation: () => Promise<T>,
  details: StartupDiagnosticDetails = {}
): Promise<T> {
  const startedAt = performance.now()
  try {
    const result = await operation()
    logRendererStartupDiagnostic(`${event}-done`, {
      durationMs: Math.round(performance.now() - startedAt),
      ...details
    })
    return result
  } catch (error) {
    logRendererStartupDiagnostic(`${event}-failed`, {
      durationMs: Math.round(performance.now() - startedAt),
      message: error instanceof Error ? error.message : String(error),
      ...details
    })
    throw error
  }
}

export function timeRendererStartupSyncStep<T>(
  event: string,
  operation: () => T,
  details: StartupDiagnosticDetails = {}
): T {
  const startedAt = performance.now()
  try {
    const result = operation()
    logRendererStartupDiagnostic(`${event}-done`, {
      durationMs: Math.round(performance.now() - startedAt),
      ...details
    })
    return result
  } catch (error) {
    logRendererStartupDiagnostic(`${event}-failed`, {
      durationMs: Math.round(performance.now() - startedAt),
      message: error instanceof Error ? error.message : String(error),
      ...details
    })
    throw error
  }
}

/**
 * A startup step that must not be able to freeze the app.
 *
 * The daemon-backed restoration steps that run BEFORE terminals reconnect can hang rather than
 * fail when the daemon is wedged — a stopped process answers its connect and then nothing — and
 * the renderer's request timeout is 30s. Waiting that out leaves the window painted but unusable,
 * which is the "frozen right after an update" report. Nothing is skipped by giving up early: the
 * main process memoizes each of these, so the work continues and its result is picked up by the
 * passes that run after reconnect.
 */
export async function timeRendererStartupStepWithDeadline<T>(
  event: string,
  operation: () => Promise<T>,
  deadlineMs: number,
  details: StartupDiagnosticDetails = {}
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<typeof DEADLINE_REACHED>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE_REACHED), deadlineMs)
  })
  try {
    const result = await Promise.race([
      timeRendererStartupStep(event, operation, details),
      deadline
    ])
    if (result === DEADLINE_REACHED) {
      logRendererStartupDiagnostic(`${event}-deadline`, { deadlineMs, ...details })
      return undefined
    }
    return result
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}
