import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'

// Why: Codex OAuth uses rotating refresh tokens stored in each home's auth.json.
// Two OmniConsole-spawned codex processes refreshing the same home concurrently can
// consume one rotation twice and permanently invalidate the stored credential,
// so OmniConsole's own spawns (quota probes, commit-message runs) serialize per home.
// User terminal panes are intentionally not serialized here.

const lockTails = new Map<string, Promise<unknown>>()

export function resolveCodexHomeProcessLockKey(codexHomePath?: string | null): string {
  const home = codexHomePath ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
  return normalizeRuntimePathForComparison(home)
}

export function resolveCodexHomeProcessLockKeyForSpawnEnv(
  env: NodeJS.ProcessEnv | undefined,
  wslDistro?: string | null
): string {
  if (wslDistro) {
    // buildWslLauncherEnv forwards only explicit values that differ from the
    // host process; all other cases use the distro user's default home.
    const codexHome = env?.CODEX_HOME !== process.env.CODEX_HOME ? (env?.CODEX_HOME ?? null) : null
    // Why: WSL spawns carry a Linux CODEX_HOME; key it through the same UNC
    // normalization the probe's \\wsl$ home path uses so both lanes collide.
    // Without an explicit home the distro default is unknowable from the host;
    // a sentinel still serializes same-distro default spawns with each other.
    return normalizeRuntimePathForComparison(
      `//wsl$/${wslDistro}${codexHome ?? '/.omni-default-codex-home'}`
    )
  }
  // An explicit env is the child's complete environment. If CODEX_HOME was
  // deliberately stripped, the child uses ~/.codex regardless of our ambient env.
  const codexHome = env === undefined ? process.env.CODEX_HOME : env.CODEX_HOME
  return normalizeRuntimePathForComparison(codexHome ?? join(homedir(), '.codex'))
}

export function withCodexHomeProcessLock<T>(
  lockKey: string,
  fn: () => Promise<T>,
  queuedSignal?: AbortSignal
): Promise<T> {
  if (queuedSignal?.aborted) {
    return Promise.reject(queuedSignal.reason)
  }
  let rejectQueued: ((reason: unknown) => void) | undefined
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectQueued = reject
  })
  const onAbort = () => rejectQueued?.(queuedSignal?.reason)
  queuedSignal?.addEventListener('abort', onAbort, { once: true })
  const prior = lockTails.get(lockKey) ?? Promise.resolve()
  const run = prior.then(() => {
    queuedSignal?.removeEventListener('abort', onAbort)
    queuedSignal?.throwIfAborted()
    return fn()
  })
  // Why: keep the queue alive past a failed run so later entrants still start.
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  lockTails.set(lockKey, tail)
  void tail.then(() => {
    if (lockTails.get(lockKey) === tail) {
      lockTails.delete(lockKey)
    }
  })
  // A cancelled waiter leaves its queue link in place until the prior owner closes.
  return queuedSignal ? Promise.race([run, cancelled]) : run
}

/**
 * Runs `fn` under the lock only when nobody holds or awaits it, and returns null otherwise. A
 * caller that already holds other capacity uses it so it never waits here while holding that.
 */
export function tryWithCodexHomeProcessLock<T>(
  lockKey: string,
  fn: () => Promise<T>
): Promise<T> | null {
  return lockTails.has(lockKey) ? null : withCodexHomeProcessLock(lockKey, fn)
}

/** Settles once everyone queued on the lock so far has finished, without taking the lock. */
export function codexHomeProcessLockReleased(lockKey: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason)
  }
  const tail = lockTails.get(lockKey)
  if (!tail || !signal) {
    return (tail ?? Promise.resolve()).then(() => undefined)
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    void tail.then(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    })
  })
}
