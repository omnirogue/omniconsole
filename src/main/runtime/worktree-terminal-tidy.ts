import type { GlobalSettings } from '../../shared/global-settings-types'
import { createSetupCompletionScanner } from './orchestration/setup-completion-signal'

/**
 * What an agent-created worktree leaves behind (setting `tidyAgentWorktreeTerminals`). Measured
 * 2026-09-30: every CLI/agent create left two bare shells, a fallback "Terminal 1" and a finished
 * "Setup" tab — 7 of that day's 29 bare shells. A person's create keeps both.
 */
export type WorktreeTerminalTidy = {
  /** Skip the bare fallback shell a create opens when nothing else supplies a first terminal. */
  skipFallbackShell: boolean
  /** Close the runtime-run Setup terminal once setup exits 0; a failed setup stays open. */
  closeSetupOnSuccess: boolean
}

export const UNTIDIED_WORKTREE_TERMINALS: WorktreeTerminalTidy = {
  skipFallbackShell: false,
  closeSetupOnSuccess: false
}

export function resolveWorktreeTerminalTidy(
  create: { initiatedBy?: 'agent'; openTerminal?: boolean },
  settings: Partial<Pick<GlobalSettings, 'tidyAgentWorktreeTerminals'>> | null | undefined
): WorktreeTerminalTidy {
  if (create.initiatedBy !== 'agent' || settings?.tidyAgentWorktreeTerminals === false) {
    return UNTIDIED_WORKTREE_TERMINALS
  }
  return { skipFallbackShell: create.openTerminal !== true, closeSetupOnSuccess: true }
}

export type SetupTerminalWatch = {
  subscribe: (listener: (data: string) => void) => () => void
  /** Output from before the watch began: setup can finish first on fast local worktrees. */
  replay: () => string | undefined
  onExit: (listener: () => void) => () => void
  /** Called once, synchronously, when the observed setup command reports exit 0. */
  succeeded: () => void
  /** Called once after `succeeded`, on a later tick. */
  close: () => Promise<unknown>
}

/**
 * Watch a Setup terminal running the observed setup command (its completion marker carries
 * `completionToken`) and close it once setup exits 0. A failed setup stays open so the person
 * sees the error; a PTY that exits first ends the watch. Returns a function that stops it.
 */
export function closeSetupTerminalOnSuccess(
  completionToken: string,
  watch: SetupTerminalWatch
): () => void {
  let stopped = false
  let stopData: () => void = () => undefined
  let stopExit: () => void = () => undefined
  const stop = (): void => {
    if (stopped) {
      return
    }
    stopped = true
    stopData()
    stopExit()
  }
  const scanner = createSetupCompletionScanner(completionToken, (exitCode) => {
    stop()
    if (exitCode !== 0) {
      return
    }
    watch.succeeded()
    // Why deferred: other observers of this same output chunk (an orchestration worker's setup
    // evidence) must read the marker before the PTY that printed it goes away.
    setTimeout(() => {
      void watch.close().catch((error: unknown) => {
        console.warn('[worktree-create] failed to close the finished Setup terminal:', error)
      })
    }, 0)
  })
  stopData = watch.subscribe(scanner.scan)
  stopExit = watch.onExit(stop)
  if (stopped) {
    return stop
  }
  const replay = watch.replay()
  if (replay) {
    scanner.scan(replay)
  }
  return stop
}

const CLOSED_SETUP_OUTCOME_LIMIT = 256

/**
 * Exit codes of Setup terminals closed after success, by handle. A later
 * `waitForSetupTerminalCompletion` must read the setup's own exit, never the PTY end the close
 * caused (or a stale handle). Bounded: the oldest entries go first.
 */
export class ClosedSetupOutcomes {
  private readonly exitCodeByHandle = new Map<string, number>()

  record(handle: string, exitCode: number): void {
    this.exitCodeByHandle.delete(handle)
    this.exitCodeByHandle.set(handle, exitCode)
    while (this.exitCodeByHandle.size > CLOSED_SETUP_OUTCOME_LIMIT) {
      const oldest = this.exitCodeByHandle.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.exitCodeByHandle.delete(oldest)
    }
  }

  get(handle: string): { exitCode: number } | null {
    const exitCode = this.exitCodeByHandle.get(handle)
    return exitCode === undefined ? null : { exitCode }
  }
}
