import type { RuntimeTerminalResolvePane, RuntimeTerminalWait } from '../../../shared/runtime-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import { isShellProcess } from '../../../shared/shell-process-detection'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import { launchAgentSessionContinuation } from '@/lib/launch-agent-session-continuation'
import {
  callRuntimeRpc,
  getActiveRuntimeTarget,
  type RuntimeClientTarget
} from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'

// Why: each slice ends with a liveness check; a minute bounds how long a queue
// waits behind an agent that died back to its shell.
const WAIT_SLICE_MS = 60 * 1000
const STALE_HANDLE_RETRY_LIMIT = 3

export type NextSessionLaunchRequest = {
  sourcePaneKey: string
  worktreeId: string
  agent: TuiAgent
  prompt: string
  /** Actor half of the launch: model and effort ids valid for `agent`. */
  model?: string
  effort?: string
  /** Session-only environment resolved from the chosen account profile. */
  launchEnv?: Record<string, string>
}

export type TerminalWaitDependencies = {
  resolveSource: () => Promise<RuntimeTerminalResolvePane>
  waitForIdle: (terminal: string) => Promise<RuntimeTerminalWait>
  /** Rejects with `timeout` when the terminal is still running after `timeoutMs` (default 15s). */
  waitForExit: (terminal: string, timeoutMs?: number) => Promise<RuntimeTerminalWait>
  /** Throws when the pane no longer runs an agent; checked each time an idle wait re-arms. */
  assertAgentAlive?: (terminal: string) => Promise<void>
  /** The pane's foreground process name, or null when the host cannot tell. */
  foregroundProcess?: (terminal: string) => Promise<string | null>
  /**
   * True when the agent's own hooks last reported the source as finished. Why: the
   * host forgets a pane's idle status across an app restart, so a wait armed after
   * one would never resolve for a session that finished before the restart.
   */
  sourceFinishedByHooks?: () => boolean
}

export type NextSessionLaunchDependencies = TerminalWaitDependencies & {
  launch: () => Promise<boolean>
}

/**
 * The host observed the source end badly or stop for attention. Every other wait
 * error (transport, stale handle, no verdict) means the outcome is unverifiable.
 */
export class SourceSessionFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SourceSessionFailedError'
  }
}

/**
 * The source stopped to ask the person (an approval, a trust or setup prompt). Still a failed
 * source for anything that must not advance past it; a plan parks under Needs you instead.
 */
export class SourceSessionBlockedError extends SourceSessionFailedError {
  readonly reason: string
  /** The pane that asked, when the caller knows it. */
  paneKey: string | null = null

  constructor(reason: string) {
    super(`The source session needs attention: ${reason}.`)
    this.name = 'SourceSessionBlockedError'
    this.reason = reason
  }
}

function isErrorMessage(error: unknown, message: string): boolean {
  return error instanceof Error && error.message === message
}

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('The queued session was cancelled.', 'AbortError')
  }
}

function assertSuccessfulExit(wait: RuntimeTerminalWait): void {
  if (wait.status !== 'exited') {
    throw new Error('The source session exited without a verifiable result.')
  }
  if (wait.exitCode === null) {
    throw new SourceSessionFailedError('The source session exited without a verifiable result.')
  }
  if (wait.exitCode !== 0) {
    throw new SourceSessionFailedError(
      `The source session exited with code ${wait.exitCode}; the next session was not started.`
    )
  }
}

/**
 * The hooks' "finished" verdict counts only while the agent still owns the pane; an
 * agent that exited to its shell must go through the exit-code path instead.
 */
async function sourceAlreadyFinished(
  dependencies: TerminalWaitDependencies,
  terminal: string
): Promise<boolean> {
  if (!dependencies.sourceFinishedByHooks?.()) {
    return false
  }
  const foreground = (await dependencies.foregroundProcess?.(terminal)) ?? null
  return !(foreground && isShellProcess(foreground))
}

/**
 * Wait until the source session is idle or has exited successfully. `exited` is true
 * only for a host-observed zero exit; an idle stop may just be the end of one turn.
 */
export async function waitForSourceSessionStop(
  dependencies: TerminalWaitDependencies,
  signal?: AbortSignal
): Promise<{ source: RuntimeTerminalResolvePane; exited: boolean }> {
  abortIfRequested(signal)
  let source = await dependencies.resolveSource()
  let staleHandleRetries = 0

  for (;;) {
    abortIfRequested(signal)
    if (await sourceAlreadyFinished(dependencies, source.handle)) {
      return { source, exited: false }
    }
    let wait: RuntimeTerminalWait
    try {
      wait = await dependencies.waitForIdle(source.handle)
    } catch (error) {
      if (isErrorMessage(error, 'terminal_handle_stale')) {
        // Why: a handle belongs to one runtime generation; when the host reissues
        // handles under a live wait, the pane is still there — resolve it again.
        if (staleHandleRetries >= STALE_HANDLE_RETRY_LIMIT) {
          throw error
        }
        staleHandleRetries += 1
        source = await dependencies.resolveSource()
        continue
      }
      if (isErrorMessage(error, 'timeout')) {
        // Why: an agent that died back to its shell never reports idle; without this
        // check a queue behind it would re-arm forever.
        await dependencies.assertAgentAlive?.(source.handle)
        continue
      }
      if (!isErrorMessage(error, 'terminal_exited')) {
        throw error
      }
      const exit = await dependencies.waitForExit(source.handle)
      assertSuccessfulExit(exit)
      return { source, exited: true }
    }

    if (wait.blockedReason) {
      throw new SourceSessionBlockedError(wait.blockedReason)
    }
    if (wait.status === 'exited') {
      assertSuccessfulExit(wait)
      return { source, exited: true }
    }
    if (wait.satisfied && wait.status === 'running') {
      return { source, exited: false }
    }
    throw new Error('The source session completion could not be verified.')
  }
}

/** The chain runner's wait: resolves with the source pane so its output can be read. */
export async function waitForSourceSessionCompletion(
  dependencies: TerminalWaitDependencies,
  signal?: AbortSignal
): Promise<RuntimeTerminalResolvePane> {
  return (await waitForSourceSessionStop(dependencies, signal)).source
}

export async function runNextSessionAfterCompletion(
  dependencies: NextSessionLaunchDependencies,
  signal?: AbortSignal
): Promise<void> {
  await waitForSourceSessionCompletion(dependencies, signal)
  abortIfRequested(signal)
  if (!(await dependencies.launch())) {
    throw new Error('The next session could not be started.')
  }
}

async function foregroundProcess(
  runtimeTarget: RuntimeClientTarget,
  terminal: string,
  signal?: AbortSignal
): Promise<string | null> {
  const result = await callRuntimeRpc<{ process: { foregroundProcess: string | null } }>(
    runtimeTarget,
    'terminal.inspectProcess',
    { terminal },
    { timeoutMs: 15_000, signal }
  )
  return result.process.foregroundProcess
}

/** The host-side waits every successor uses: resolve the pane, wait for idle, wait for exit. */
export function createTerminalWaitDependencies(
  runtimeTarget: RuntimeClientTarget,
  request: { sourcePaneKey: string; worktreeId: string },
  signal?: AbortSignal
): TerminalWaitDependencies {
  return {
    resolveSource: async () => {
      const result = await callRuntimeRpc<{ terminal: RuntimeTerminalResolvePane }>(
        runtimeTarget,
        'terminal.resolvePane',
        { paneKey: request.sourcePaneKey, worktreeId: request.worktreeId },
        { timeoutMs: 15_000, signal }
      )
      return result.terminal
    },
    waitForIdle: async (terminal) => {
      const result = await callRuntimeRpc<{ wait: RuntimeTerminalWait }>(
        runtimeTarget,
        'terminal.wait',
        { terminal, for: 'tui-idle', timeoutMs: WAIT_SLICE_MS },
        { timeoutMs: WAIT_SLICE_MS + 5_000, signal }
      )
      return result.wait
    },
    waitForExit: async (terminal, timeoutMs = 15_000) => {
      const result = await callRuntimeRpc<{ wait: RuntimeTerminalWait }>(
        runtimeTarget,
        'terminal.wait',
        { terminal, for: 'exit', timeoutMs },
        { timeoutMs: timeoutMs + 5_000, signal }
      )
      return result.wait
    },
    foregroundProcess: (terminal) => foregroundProcess(runtimeTarget, terminal, signal),
    sourceFinishedByHooks: () =>
      useAppStore.getState().agentStatusByPaneKey[request.sourcePaneKey]?.state === 'done',
    assertAgentAlive: async (terminal) => {
      const foreground = await foregroundProcess(runtimeTarget, terminal, signal)
      // Why: only a shell in the foreground proves the agent left. Any other name is
      // not evidence: the native Claude binary reports its version number as its
      // process name, and tool subprocesses take the foreground while an agent works.
      if (foreground && isShellProcess(foreground)) {
        throw new SourceSessionFailedError(
          `The session's agent is no longer running (${foreground} is in the foreground); the next session was not started.`
        )
      }
    }
  }
}

export function createNextSessionLaunchDependencies(
  request: NextSessionLaunchRequest,
  signal?: AbortSignal
): NextSessionLaunchDependencies {
  const state = useAppStore.getState()
  const runtimeTarget = getActiveRuntimeTarget(
    getSettingsForWorktreeRuntimeOwner(state, request.worktreeId)
  )
  const workspacePath = state.getKnownWorktreeById(request.worktreeId)?.path
  if (!workspacePath) {
    throw new Error('The source workspace is no longer available.')
  }

  return {
    ...createTerminalWaitDependencies(runtimeTarget, request, signal),
    launch: () =>
      launchAgentSessionContinuation({
        agent: request.agent,
        prompt: request.prompt,
        worktreeId: request.worktreeId,
        workspacePath,
        initialCwd: workspacePath,
        launchSource: 'sidebar',
        ...(request.model
          ? {
              launchPreferences: {
                model: request.model,
                ...(request.effort ? { effort: request.effort } : {})
              }
            }
          : {}),
        ...(request.launchEnv ? { launchEnv: request.launchEnv } : {})
      })
  }
}
