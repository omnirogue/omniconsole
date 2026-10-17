import type { WorkflowPlacement } from '../../../shared/local-workflow-placement'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import { workflowFleetSeatVerdict } from './workflow-fleet-seat-launch'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import {
  PROCESS_START_TIME_TOLERANCE_MS,
  readProcessStartTimeMs
} from '../agent-session-process-identity-probe'
import { forceTerminatePosixProcessGroup } from '../../../shared/child-process/process-tree-termination'
import type {
  WorkflowInterruptedEvidence,
  WorkflowOrphanedAttempt
} from './workflow-checkpoint-process'
import type { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import { readWorkflowLaunchReceipt, type WorkflowLaunchReceipt } from './workflow-process-receipt'

// Why: a quit, crash or update mid-run leaves busy agents with a launch receipt and no terminal
// receipt (the owner writes it after exit), which held the run at "Needs you" with no way out.
// Missing files still settle nothing; a probe of the recorded process does.

/** A live process that started this long before its recorded launch is not that launch. */
const LAUNCH_LEAD_MS = 60_000

export type WorkflowInterruptedProcessProbe = {
  /** False only when the pid is proven absent (ESRCH). */
  isPidPresent: (pid: number) => boolean
  /** False only when the process group is proven absent (ESRCH). */
  isGroupPresent: (processGroupId: number) => boolean
  readStartTimeMs: (pid: number) => Promise<number | null>
  /** Ends the group; true once nothing but zombies is left in it. */
  terminateGroup: (processGroupId: number) => Promise<boolean>
}

function present(target: number): boolean {
  try {
    process.kill(target, 0)
    return true
  } catch (error) {
    // Only ESRCH proves absence; EPERM is a live process owned by someone else.
    return (error as NodeJS.ErrnoException)?.code !== 'ESRCH'
  }
}

const HOST_PROCESSES: WorkflowInterruptedProcessProbe = {
  isPidPresent: (pid) => present(pid),
  isGroupPresent: (processGroupId) => present(-processGroupId),
  readStartTimeMs: (pid) => readProcessStartTimeMs(pid),
  terminateGroup: (processGroupId) => forceTerminatePosixProcessGroup(processGroupId)
}

export type WorkflowInterruptedProcessVerdict =
  | { kind: 'gone'; groupCleanupRequired: boolean }
  | { kind: 'orphan' }
  | { kind: 'unknown'; reason: string }

/**
 * What became of a launched agent whose owner died. The recorded leader pid is the agent: it
 * led its own process group, and launch.json was written synchronously right after the spawn.
 */
export async function probeInterruptedWorkflowProcess(
  launch: Pick<WorkflowLaunchReceipt, 'pid' | 'launchedAt'>,
  probe: WorkflowInterruptedProcessProbe = HOST_PROCESSES
): Promise<WorkflowInterruptedProcessVerdict> {
  const { pid, launchedAt } = launch
  if (!probe.isPidPresent(pid)) {
    // The agent itself has exited, so it can produce nothing more. Leftover members of its group
    // are never signalled: once the leader is gone its group id is no proof of whose they are.
    return { kind: 'gone', groupCleanupRequired: probe.isGroupPresent(pid) }
  }
  const started = await probe.readStartTimeMs(pid).catch(() => null)
  if (started === null) {
    return { kind: 'unknown', reason: `its process (pid ${pid}) could not be identified` }
  }
  if (started > launchedAt + PROCESS_START_TIME_TOLERANCE_MS || pid === process.pid) {
    // Pids are reused only after their process group has ended, so the agent's group is gone too.
    return { kind: 'gone', groupCleanupRequired: false }
  }
  if (started < launchedAt - LAUNCH_LEAD_MS) {
    return { kind: 'unknown', reason: `another process holds its pid (${pid})` }
  }
  return { kind: 'orphan' }
}

function exists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

type AttemptVerdict =
  | { kind: 'settle'; evidence: WorkflowInterruptedEvidence }
  /** A terminal receipt exists: the ordinary recovery path reads and validates it. */
  | { kind: 'recorded' }
  | { kind: 'unknown'; reason: string }

async function attemptVerdict(
  store: WorkflowCheckpointStore,
  attempt: WorkflowOrphanedAttempt,
  fence: number,
  probe: WorkflowInterruptedProcessProbe,
  placement?: WorkflowPlacement,
  remote: typeof workflowFleetSeatVerdict = workflowFleetSeatVerdict
): Promise<AttemptVerdict> {
  if (attempt.receipt_json === null) {
    // Preparation is recorded before any process can start, so nothing was launched.
    return attempt.state === 'prepared'
      ? { kind: 'settle', evidence: { launched: false } }
      : { kind: 'unknown', reason: 'its launch was never recorded' }
  }
  const identity = store.readProcessIdentity(attempt.id, fence)
  const directory = join(identity.directory, identity.attemptId)
  const recorded = exists(join(directory, 'terminal.json'))
  if (recorded && placement?.mode !== 'dispatched-seats') {
    return { kind: 'recorded' }
  }
  let launch: WorkflowLaunchReceipt
  try {
    launch = readWorkflowLaunchReceipt(identity)
  } catch (error) {
    // The attempt directory is created before the process starts and launch.json is written
    // synchronously after it, so a prepared attempt without its directory never launched.
    if (attempt.state === 'prepared' && !exists(directory)) {
      return { kind: 'settle', evidence: { launched: false } }
    }
    const missing = (error as NodeJS.ErrnoException)?.code === 'ENOENT'
    return {
      kind: 'unknown',
      reason: missing
        ? 'OmniConsole cannot tell whether this agent started before it closed'
        : 'its launch record does not match this run'
    }
  }
  const found = await probeInterruptedWorkflowProcess(launch, probe)
  if (found.kind === 'unknown') {
    return found
  }
  if (found.kind === 'orphan' && !(await probe.terminateGroup(launch.pid).catch(() => false))) {
    return {
      kind: 'unknown',
      reason: `it is still running (pid ${launch.pid}) and could not be stopped`
    }
  }
  if (placement?.mode === 'dispatched-seats') {
    const dispatch = JSON.parse(launch.launchJson).dispatch
    const alias = placement.host?.ssh
    const expected = placement.dispatch && `${placement.dispatch.root}/attempts/${attempt.id}`
    if (
      !alias ||
      !expected ||
      dispatch?.directory !== expected ||
      dispatch?.machine !== placement.host?.machine ||
      dispatch?.host !== placement.host?.name
    ) {
      return { kind: 'unknown', reason: 'its remote launch identity does not match this run' }
    }
    const verdict = await remote(alias, expected, true)
    if (verdict !== 'exited' && verdict !== 'not-started') {
      return {
        kind: 'unknown',
        reason: `its seat on ${placement.host?.name} is ${verdict}; exit must be confirmed before Resume`
      }
    }
  }
  if (recorded) {
    return { kind: 'recorded' }
  }
  return {
    kind: 'settle',
    evidence: {
      launched: true,
      groupCleanupRequired: found.kind === 'gone' && found.groupCleanupRequired,
      stopped: found.kind === 'orphan' || placement?.mode === 'dispatched-seats'
    }
  }
}

export type WorkflowInterruptedSettlement = {
  /** Call ids whose attempts settled as interrupted. */
  settled: string[]
  /** Attempts still unresolved, by attempt id, with a reason a person can read. */
  unresolved: Map<string, string>
}

/**
 * Settles every attempt the replaced owner left without exit evidence, before the program is
 * replayed. Attempts with a terminal receipt are left to the ordinary recovery path. Runs only
 * after claimOwner has proven the previous owner dead and moved the run to a new fence.
 */
export async function settleInterruptedWorkflowAttempts(input: {
  store: WorkflowCheckpointStore
  executionId: string
  fence: number
  probe?: WorkflowInterruptedProcessProbe
  remote?: typeof workflowFleetSeatVerdict
}): Promise<WorkflowInterruptedSettlement> {
  const { store, executionId, fence } = input
  const snapshot = store.inspect(executionId, fence).snapshot as LocalWorkflowHostSnapshot
  const settlement: WorkflowInterruptedSettlement = { settled: [], unresolved: new Map() }
  for (const attempt of store.attempts.orphanedAttempts(executionId, fence)) {
    try {
      const verdict = await attemptVerdict(
        store,
        attempt,
        fence,
        input.probe ?? HOST_PROCESSES,
        snapshot.host?.placement,
        input.remote
      )
      if (verdict.kind === 'unknown') {
        settlement.unresolved.set(attempt.id, verdict.reason)
      } else if (verdict.kind === 'settle') {
        store.attempts.settleInterrupted(attempt.id, fence, attempt, verdict.evidence)
        settlement.settled.push(attempt.call_id)
      }
    } catch (error) {
      settlement.unresolved.set(attempt.id, error instanceof Error ? error.message : String(error))
    }
  }
  return settlement
}

/** The run's note once every interrupted agent is settled and the run waits for Resume. */
export function workflowInterruptedNote(count: number): string {
  return count === 1
    ? '1 agent was interrupted when OmniConsole closed. Resume runs it again.'
    : `${count} agents were interrupted when OmniConsole closed. Resume runs them again.`
}
