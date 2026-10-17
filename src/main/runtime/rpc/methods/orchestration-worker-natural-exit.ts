import {
  isPtyLaunchGateReceipt,
  type PtyLaunchGateReceipt
} from '../../../../shared/pty-launch-gate'
import type { RuntimeTerminalWait } from '../../../../shared/runtime-terminal-contracts'
import { TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { OrcaRuntimeService } from '../../omni-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import {
  readConsoleJobProcessHandshake,
  recordConsoleJobProcessHandshake,
  type ConsoleJobProcessIdentity
} from '../../orchestration/console-job-process-handshake'
import { WORKER_RELEASABLE_STATES } from '../../orchestration/worker-terminal-ownership'
import {
  workerTerminalLeaseIsCurrent,
  workerTerminalIdentityIsCurrent,
  type WorkerTerminalHostScope,
  type WorkerTerminalLeaseRuntime
} from './orchestration-worker-terminal-lease'

export type WorkerNaturalExitRuntime = WorkerTerminalLeaseRuntime &
  Pick<OrcaRuntimeService, 'waitForTerminal' | 'sendTerminal'>

/** Main supplies execution-host evidence for the gate's exact process, including a fresh birth check while live. */
export type WorkerNaturalExitObservation = {
  gate: PtyLaunchGateReceipt
  hostScope: WorkerTerminalHostScope
  status: 'live' | 'exited' | 'unverifiable'
  agent: TuiAgent | null
  launchGateReleased: boolean
  reason?: string
  /** Captured only by the incarnation-fenced physical onPtyExit callback, before workerRelease. */
  exit?: { observedAt: string; providerExitObserved: boolean; wait: RuntimeTerminalWait }
}

export type WorkerNaturalExitResult =
  | {
      status: 'exited'
      gate: PtyLaunchGateReceipt
      observedAt: string
      exitCode: number
      exitCause: { kind: 'exited'; exitCode: number }
    }
  | { status: 'live' | 'unverifiable' | 'refused'; reason: string }

type ExitArgs = {
  runtime: WorkerNaturalExitRuntime
  db: OrchestrationDb
  dispatchId: string
  gate: PtyLaunchGateReceipt
  observeProcess: (gate: PtyLaunchGateReceipt) => Promise<WorkerNaturalExitObservation | null>
  consoleJob?: ConsoleJobProcessIdentity
  redactConsoleJobProcess?: (value: unknown) => unknown
  timeoutMs?: number
}

type ExitAttempt = {
  gate: PtyLaunchGateReceipt
  requested: boolean
  active?: Promise<WorkerNaturalExitResult>
}
const attempts = new WeakMap<WorkerNaturalExitRuntime, Map<string, ExitAttempt>>()

/** Requests provider input once; retries only observe. Cleanup remains workerRelease's responsibility. */
export function requestWorkerNaturalExit(args: ExitArgs): Promise<WorkerNaturalExitResult> {
  if (!isPtyLaunchGateReceipt(args.gate)) {
    return Promise.resolve({ status: 'refused', reason: 'invalid_exit_request' })
  }
  let byGate = attempts.get(args.runtime)
  if (!byGate) {
    byGate = new Map()
    attempts.set(args.runtime, byGate)
  }
  const key = JSON.stringify([args.dispatchId, args.gate.gateId, args.consoleJob ?? null])
  const attempt: ExitAttempt = byGate.get(key) ?? {
    gate: Object.freeze({ ...args.gate }),
    requested: false
  }
  if (!sameGate(attempt.gate, args.gate)) {
    return Promise.resolve({ status: 'refused', reason: 'worker_exit_identity_changed' })
  }
  byGate.set(key, attempt)
  if (attempt.active) {
    return attempt.active
  }
  const active = requestOnce({ ...args, gate: attempt.gate }, attempt).finally(() => {
    if (attempt.active === active) {
      attempt.active = undefined
    }
  })
  attempt.active = active
  return active
}

async function requestOnce(args: ExitArgs, attempt: ExitAttempt): Promise<WorkerNaturalExitResult> {
  const { runtime, db, dispatchId, gate } = args
  const timeoutMs = args.timeoutMs ?? 10_000
  if (
    !isPtyLaunchGateReceipt(gate) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 60_000
  ) {
    return { status: 'refused', reason: 'invalid_exit_request' }
  }
  const resource = db.getWorkerTerminalResourceByOwner(dispatchId)
  if (db.getFederatedDispatch(dispatchId) || !resource) {
    return { status: 'refused', reason: 'no_owned_local_worker' }
  }
  const handle = resource.terminal_handle
  const assertOwnership = (
    ptyId = gate.ptyId,
    observation?: WorkerNaturalExitObservation | null
  ): void => {
    const current = db.getWorkerTerminalResourceByOwner(dispatchId)
    const worker = db.getWorkerDispatch(dispatchId)
    const authority = runtime.getOrchestrationDispatchAuthority(handle)
    const observedExit =
      observation?.status === 'exited' && observation.exit?.providerExitObserved === true
    const hostScope = observedExit ? observation.hostScope : authority?.hostScope
    if (
      ptyId !== gate.ptyId ||
      current?.id !== resource.id ||
      current.ownership_state !== 'owned' ||
      current.release_state !== 'not_requested' ||
      !worker ||
      !WORKER_RELEASABLE_STATES.includes(worker.state) ||
      hostScope?.kind !== 'local' ||
      current.process_incarnation !== `${gate.ptyId}:${gate.incarnationId}` ||
      !(observedExit
        ? workerTerminalIdentityIsCurrent(runtime, db, dispatchId, current, hostScope)
        : workerTerminalLeaseIsCurrent(runtime, db, dispatchId, current))
    ) {
      throw new Error('worker_exit_ownership_unproven')
    }
  }
  const read = async (): Promise<WorkerNaturalExitObservation | null> => {
    const dispatch = db.getDispatchContextById(dispatchId)
    if (dispatch && db.getRun(dispatch.run_id)?.console_job && !args.consoleJob) {
      throw new Error('console_worker_exit_requires_durable_identity')
    }
    if (args.consoleJob) {
      const handshake = readConsoleJobProcessHandshake(db, args.consoleJob)
      if (
        args.consoleJob.dispatchId !== dispatchId ||
        !handshake?.released ||
        !sameGate(gate, handshake.gate)
      ) {
        throw new Error('console_worker_exit_handshake_unproven')
      }
      attempt.requested ||= Boolean(handshake.exitIntent)
    }
    const observation = await args.observeProcess(gate).catch(() => null)
    if (!observation || !sameGate(gate, observation.gate)) {
      return null
    }
    if (
      observation.hostScope.kind !== 'local' ||
      JSON.stringify(observation.hostScope) !== resource.host_scope
    ) {
      return null
    }
    assertOwnership(gate.ptyId, observation)
    return observation
  }
  const outcome = (observation: WorkerNaturalExitObservation | null): WorkerNaturalExitResult =>
    observedExitResult(gate, handle, observation)

  try {
    let observation = await read()
    let result = outcome(observation)
    if (result.status !== 'live') {
      return result
    }
    const policy = observation?.agent
      ? TUI_AGENT_CONFIG[observation.agent]?.gracefulExit
      : undefined
    const agent = observation?.agent
    if (!policy) {
      return { status: 'refused', reason: 'provider_graceful_exit_unsupported' }
    }
    if (!attempt.requested) {
      const ready = await runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs })
      observation = await read()
      result = outcome(observation)
      if (result.status !== 'live') {
        return result
      }
      if (
        ready.handle !== handle ||
        ready.condition !== 'tui-idle' ||
        !ready.satisfied ||
        ready.status !== 'running' ||
        ready.blockedReason
      ) {
        return { status: 'refused', reason: 'provider_not_idle' }
      }
      const beforeWrite = async (ptyId: string): Promise<void> => {
        assertOwnership(ptyId)
        const current = await read()
        if (outcome(current).status !== 'live' || current?.agent !== agent) {
          throw new Error('worker_exit_process_not_live')
        }
      }
      // A partial or unacknowledged write must never be replayed into a surviving prompt.
      attempt.requested = true
      let reserved = false
      await runtime.sendTerminal(
        handle,
        { text: policy.command, enter: true },
        {
          beforeWrite,
          reserveWrite: (ptyId) => {
            assertOwnership(ptyId)
            if (args.consoleJob) {
              const { fresh } = recordConsoleJobProcessHandshake(
                db,
                args.consoleJob,
                { phase: 'exit_intent', gate },
                args.redactConsoleJobProcess
              )
              if (!fresh && !reserved) {
                throw new Error('console_worker_exit_already_requested')
              }
              reserved = true
            }
          }
        }
      )
    }
    await runtime.waitForTerminal(handle, { condition: 'exit', timeoutMs }).catch(() => null)
    return outcome(await read())
  } catch (error) {
    try {
      const result = outcome(await read())
      if (result.status === 'exited') {
        return result
      }
    } catch {
      return { status: 'refused', reason: 'worker_exit_ownership_unproven' }
    }
    return {
      status: 'unverifiable',
      reason: error instanceof Error ? error.message : 'worker_exit_observation_unavailable'
    }
  }
}

function sameGate(expected: PtyLaunchGateReceipt, observed: PtyLaunchGateReceipt): boolean {
  return (
    isPtyLaunchGateReceipt(observed) &&
    Object.entries(expected).every(
      ([key, value]) => observed[key as keyof PtyLaunchGateReceipt] === value
    )
  )
}

function observedExitResult(
  gate: PtyLaunchGateReceipt,
  handle: string,
  observation: WorkerNaturalExitObservation | null
): WorkerNaturalExitResult {
  if (!observation || observation.status === 'unverifiable') {
    return { status: 'unverifiable', reason: observation?.reason ?? 'host_observation_unavailable' }
  }
  if (
    !observation.launchGateReleased ||
    gate.startupCommandMode !== 'exec' ||
    !gate.reportsChildExitStatus
  ) {
    return { status: 'refused', reason: 'provider_exit_fidelity_unproven' }
  }
  if (observation.status === 'live') {
    return { status: 'live', reason: 'process_still_live' }
  }
  const exit = observation.exit
  const wait = exit?.wait
  if (
    !exit?.providerExitObserved ||
    !Number.isFinite(Date.parse(exit.observedAt)) ||
    Date.parse(exit.observedAt) < gate.processStartTimeMs ||
    wait?.handle !== handle ||
    wait.condition !== 'exit' ||
    !wait.satisfied ||
    wait.status !== 'exited' ||
    !Number.isSafeInteger(wait.exitCode) ||
    (wait.exitCode as number) < 0 ||
    !wait.exitCause ||
    wait.exitCause.kind === 'unknown'
  ) {
    return { status: 'unverifiable', reason: 'physical_exit_evidence_missing' }
  }
  if (wait.exitCause.kind !== 'exited' || wait.exitCause.exitCode !== wait.exitCode) {
    return { status: 'refused', reason: 'not_natural_provider_exit' }
  }
  return {
    status: 'exited',
    gate: { ...gate },
    observedAt: exit.observedAt,
    exitCode: wait.exitCode as number,
    exitCause: { ...wait.exitCause }
  }
}
