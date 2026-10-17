import {
  visibleWorkerStartupPrompt,
  type StartupScreenReader
} from './orchestration-worker-startup-screen'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type {
  RuntimeTerminalWait,
  RuntimeTerminalWaitBlockedReason
} from '../../../../shared/runtime-terminal-contracts'

/**
 * A readiness wait that ended on a startup prompt the agent cannot pass by itself. The message stays
 * the sentence people already read; the blocker id travels beside it, so a reader that decides on it
 * (the session recovery ladder) never has to take it back out of prose.
 */
export class WorkerStartupBlockedError extends Error {
  constructor(readonly startupBlocker: RuntimeTerminalWaitBlockedReason) {
    super(`Agent startup blocked: ${startupBlocker}`)
  }
}

/** Why a readiness wait failed: one reading for the local worker start and its federation twin. */
export function workerReadinessFailure(
  wait: Pick<RuntimeTerminalWait, 'blockedReason' | 'status'>
): Error {
  return wait.blockedReason
    ? new WorkerStartupBlockedError(wait.blockedReason)
    : new Error(`Agent did not become ready (${wait.status}).`)
}

export function workerStartupBlocker(error: unknown): RuntimeTerminalWaitBlockedReason | undefined {
  return error instanceof WorkerStartupBlockedError ? error.startupBlocker : undefined
}

/** A failed start receipt, with the blocker id as its own field whenever the failure named one. */
export function withWorkerStartupBlocker(receipt: unknown, error: unknown): unknown {
  const startupBlocker = workerStartupBlocker(error)
  return startupBlocker && receipt && typeof receipt === 'object'
    ? { ...receipt, startupBlocker }
    : receipt
}

export async function assertWorkerStartupReady(
  runtime: StartupScreenReader,
  terminalHandle: string,
  agent: TuiAgent,
  wait: Pick<RuntimeTerminalWait, 'satisfied' | 'blockedReason' | 'status'>
): Promise<void> {
  if (!wait.satisfied) {
    throw workerReadinessFailure(wait)
  }
  const prompt = await visibleWorkerStartupPrompt(runtime, terminalHandle, agent)
  if (prompt) {
    throw new WorkerStartupBlockedError(prompt)
  }
}
