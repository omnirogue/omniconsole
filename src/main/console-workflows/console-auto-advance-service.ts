import {
  isConsoleAutoAdvanceWorkflowId,
  isConsoleAutoAdvanceWorktree,
  type ConsoleAutoAdvancePreference,
  type ConsoleAutoAdvanceSetRequest
} from '../../shared/console-auto-advance'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type { ConsoleAutoAdvance } from './console-auto-advance'
import { resolveConsoleAutoAdvanceRunner } from './console-auto-advance-registry'

/**
 * Why the message says "this host": auto-advance drives the backoffice console session,
 * which only the Electron main process holds. A plain-Node runtime (orcad) reads and
 * writes the preference but has no runner, and saying so beats a silent no-op.
 */
const NO_RUNNER = 'Auto-advance needs the OmniConsole desktop session; this host has none.'

/** The runner bound to this runtime's single console local execution service. */
export function getConsoleAutoAdvanceService(runtime: OrcaRuntimeService): ConsoleAutoAdvance {
  const runner = resolveConsoleAutoAdvanceRunner(runtime)
  if (!runner) {
    throw new Error(NO_RUNNER)
  }
  return runner
}

export function readConsoleAutoAdvance(
  runtime: OrcaRuntimeService,
  workflowId: string
): ConsoleAutoAdvancePreference {
  return runtime.getConsoleAutoAdvance(workflowId)
}

/** Turning it off stops the bounded poll immediately; turning it on starts one cycle now. */
export function writeConsoleAutoAdvance(
  runtime: OrcaRuntimeService,
  request: ConsoleAutoAdvanceSetRequest
): ConsoleAutoAdvancePreference {
  if (
    !request ||
    typeof request.enabled !== 'boolean' ||
    !isConsoleAutoAdvanceWorkflowId(request.workflowId) ||
    (request.worktree !== undefined && !isConsoleAutoAdvanceWorktree(request.worktree))
  ) {
    throw new Error('Name one admitted workflow, the exact workspace, and on or off.')
  }
  // Why resolved before the write: persisting "on" where nothing can start a job would
  // leave the person reading "waiting for the next local job" forever. Turning it off is
  // always allowed — a host that cannot run it also cannot be left running.
  const runner = resolveConsoleAutoAdvanceRunner(runtime)
  if (request.enabled && !runner) {
    throw new Error(NO_RUNNER)
  }
  const preference = runtime.setConsoleAutoAdvance({
    workflowId: request.workflowId,
    enabled: request.enabled,
    ...(request.worktree === undefined ? {} : { worktree: request.worktree })
  })
  if (runner) {
    if (preference.enabled) {
      runner.begin(preference.workflowId)
    } else {
      runner.stop(preference.workflowId)
    }
  }
  return preference
}
