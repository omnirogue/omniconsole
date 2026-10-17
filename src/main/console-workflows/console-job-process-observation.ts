import { setTimeout as delay } from 'node:timers/promises'
import type { PtyLaunchGateObservation } from '../../shared/pty-launch-gate'
import { redactConsoleWorkflowMemory } from '../backoffice/console-workflow-credential-memory'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import {
  readConsoleJobProcessHandshake,
  recordConsoleJobProcessHandshake,
  type ConsoleJobPhysicalExit,
  type ConsoleJobProcessHandshake,
  type ConsoleJobProcessIdentity
} from '../runtime/orchestration/console-job-process-handshake'
import {
  requestWorkerNaturalExit,
  type WorkerNaturalExitObservation
} from '../runtime/rpc/methods/orchestration-worker-natural-exit'
import type { WorkerTerminalHostScope } from '../runtime/rpc/methods/orchestration-worker-terminal-lease'
import type { ConsoleLocalTerminalProof } from './console-local-execution-contract'
import type { ConsoleLocalExecutionRecord } from './console-local-execution-state'

export type ConsoleJobProcessObservation =
  | { state: 'live' | 'unverifiable'; reason: string }
  | { state: 'exited'; proof: ConsoleLocalTerminalProof }

export function consoleJobProcessIdentity(
  record: ConsoleLocalExecutionRecord
): ConsoleJobProcessIdentity {
  if (!record.run.console_job_principal) {
    throw new Error('The process has no bound console principal.')
  }
  return {
    runId: record.run.id,
    dispatchId: record.worker.dispatch_id,
    principal: record.run.console_job_principal,
    binding: record.binding
  }
}

export async function waitForConsoleJobProcessExit(
  runtime: OrcaRuntimeService,
  identity: ConsoleJobProcessIdentity
): Promise<ConsoleJobProcessObservation> {
  let observation = await observeConsoleJobProcess(runtime, identity)
  // The kernel receipt pipe may finish just after terminal-stop or terminal-exit acknowledgement.
  for (let poll = 0; poll < 20 && observation.state !== 'exited'; poll++) {
    await delay(50)
    observation = await observeConsoleJobProcess(runtime, identity)
  }
  return observation
}

/** Only the execution host or its already committed physical receipt can prove death. */
export async function observeConsoleJobProcess(
  runtime: OrcaRuntimeService,
  identity: ConsoleJobProcessIdentity
): Promise<ConsoleJobProcessObservation> {
  const db = runtime.getOrchestrationDb()
  const handshake = readConsoleJobProcessHandshake(db, identity)
  if (!handshake) {
    return { state: 'unverifiable', reason: 'The exact prepared process receipt is missing.' }
  }
  const { gate } = handshake
  if (
    db.getFederatedDispatch(identity.dispatchId) ||
    gate.exitObserver !== 'macos-kqueue' ||
    gate.startupCommandMode !== 'exec' ||
    !gate.reportsChildExitStatus
  ) {
    return { state: 'unverifiable', reason: 'The registered process observer is unsupported.' }
  }
  if (handshake.physicalExit?.event.phase === 'physical_exit') {
    return terminalObservation(identity, handshake, handshake.physicalExit.event.exit)
  }
  const observed = await runtime.readTerminalLaunchGateObservation(gate).catch(() => null)
  if (
    !observed ||
    observed.gateId !== gate.gateId ||
    observed.ptyId !== gate.ptyId ||
    observed.incarnationId !== gate.incarnationId ||
    observed.pid !== gate.pid ||
    observed.processStartTimeMs !== gate.processStartTimeMs
  ) {
    return { state: 'unverifiable', reason: 'The host did not verify the exact process identity.' }
  }
  if (observed.state === 'unverifiable') {
    return { state: 'unverifiable', reason: observed.reason }
  }
  const closed =
    observed.startAcknowledgement === null && !handshake.releaseIntent && !handshake.released
  const released =
    observed.startAcknowledgement === handshake.startAcknowledgement &&
    Boolean(handshake.releaseIntent)
  if (observed.source !== 'macos-kqueue' || (!closed && !released)) {
    return {
      state: 'unverifiable',
      reason: 'The host gate acknowledgement does not match the journal.'
    }
  }
  // An acknowledged release can be recovered after a crash before its local commit.
  if (!handshake.released && handshake.releaseIntent && observed.startAcknowledgement) {
    handshake.released = recordConsoleJobProcessHandshake(
      db,
      identity,
      {
        phase: 'released',
        gate,
        released: {
          gateId: gate.gateId,
          state: 'released',
          startAcknowledgement: observed.startAcknowledgement
        }
      },
      redactConsoleWorkflowMemory
    ).record
  }
  if (observed.state === 'live') {
    return { state: 'live', reason: 'The registered process is still live.' }
  }
  const exit = physicalExit(observed)
  if (!exit || observed.observedAtMs < gate.processStartTimeMs) {
    return { state: 'unverifiable', reason: 'The host physical exit status is inconsistent.' }
  }
  const recorded = recordConsoleJobProcessHandshake(
    db,
    identity,
    { phase: 'physical_exit', gate, exit },
    redactConsoleWorkflowMemory
  )
  if (recorded.record.event.phase !== 'physical_exit') {
    throw new Error('The physical exit receipt was not committed.')
  }
  return terminalObservation(identity, handshake, recorded.record.event.exit)
}

function physicalExit(
  observed: Extract<PtyLaunchGateObservation, { state: 'exited' }>
): ConsoleJobPhysicalExit | null {
  const { waitStatus, exitCode, signal, observedAtMs } = observed
  if (
    !Number.isSafeInteger(waitStatus) ||
    waitStatus < 0 ||
    waitStatus > 65535 ||
    !Number.isSafeInteger(observedAtMs) ||
    !Number.isFinite(new Date(observedAtMs).getTime())
  ) {
    return null
  }
  const observedAt = new Date(observedAtMs).toISOString()
  if (
    signal === null &&
    Number.isSafeInteger(exitCode) &&
    exitCode! >= 0 &&
    exitCode! <= 255 &&
    waitStatus === exitCode! * 256
  ) {
    return {
      observedAt,
      processExitCode: exitCode,
      exitCause: { kind: 'exited', exitCode: exitCode! }
    }
  }
  if (
    exitCode === null &&
    Number.isSafeInteger(signal) &&
    signal! > 0 &&
    signal! < 127 &&
    (waitStatus & 127) === signal &&
    (waitStatus & 0xff00) === 0
  ) {
    return { observedAt, processExitCode: null, exitCause: { kind: 'signaled', signal: signal! } }
  }
  return null
}

function terminalObservation(
  identity: ConsoleJobProcessIdentity,
  handshake: ConsoleJobProcessHandshake,
  exit: ConsoleJobPhysicalExit
): ConsoleJobProcessObservation {
  const { gate } = handshake
  // Registration may have committed while the executor was still held behind the closed gate.
  const notStarted = !handshake.releaseIntent && !handshake.released
  if (!identity.binding.claim || (!notStarted && !handshake.released)) {
    return { state: 'unverifiable', reason: 'The process launch phase is unresolved.' }
  }
  const cause = exit.exitCause
  return {
    state: 'exited',
    proof: {
      kind: notStarted ? 'not_started' : 'exited',
      process_identity: {
        pid: gate.pid,
        started_at: new Date(gate.processStartTimeMs).toISOString(),
        runner_instance: identity.binding.claim.runnerInstance
      },
      process_exited: true,
      process_exit_code: exit.processExitCode,
      exit_cause: cause.kind === 'exited' ? { kind: 'exited', exit_code: cause.exitCode } : cause,
      observed_at: exit.observedAt,
      ...(notStarted ? { launch_gate_closed: true } : {})
    }
  }
}

export async function finishConsoleJobProcess(
  runtime: OrcaRuntimeService,
  record: ConsoleLocalExecutionRecord
): Promise<ConsoleLocalTerminalProof> {
  const identity = consoleJobProcessIdentity(record)
  const db = runtime.getOrchestrationDb()
  const handshake = readConsoleJobProcessHandshake(db, identity)
  if (!handshake) {
    throw new Error(
      'The settled worker has no prepared process receipt; its state is unverifiable.'
    )
  }
  const worker = db.getWorkerDispatch(identity.dispatchId)
  const agent = worker ? JSON.parse(worker.start_options).agent : null
  if (agent !== record.attempt.job.provider) {
    throw new Error('The provider does not match the frozen Dispatch launch preferences.')
  }
  const result = await requestWorkerNaturalExit({
    runtime,
    db,
    dispatchId: identity.dispatchId,
    gate: handshake.gate,
    consoleJob: identity,
    redactConsoleJobProcess: redactConsoleWorkflowMemory,
    observeProcess: async (): Promise<WorkerNaturalExitObservation | null> => {
      const observation = await observeConsoleJobProcess(runtime, identity)
      const resource = db.getWorkerTerminalResourceByOwner(identity.dispatchId)
      const hostScope = resource?.host_scope
        ? (JSON.parse(resource.host_scope) as WorkerTerminalHostScope)
        : null
      if (!resource || hostScope?.kind !== 'local') {
        return null
      }
      const proof = observation.state === 'exited' ? observation.proof : null
      return {
        gate: handshake.gate,
        hostScope,
        status: observation.state,
        agent,
        launchGateReleased: Boolean(readConsoleJobProcessHandshake(db, identity)?.released),
        ...('reason' in observation ? { reason: observation.reason } : {}),
        ...(proof
          ? {
              exit: {
                observedAt: proof.observed_at,
                providerExitObserved: true,
                wait: {
                  handle: resource.terminal_handle,
                  condition: 'exit',
                  satisfied: true,
                  status: 'exited',
                  exitCode: proof.process_exit_code,
                  exitCause:
                    proof.exit_cause.kind === 'exited'
                      ? { kind: 'exited', exitCode: proof.exit_cause.exit_code }
                      : proof.exit_cause
                }
              }
            }
          : {})
      }
    }
  })
  const physical = await waitForConsoleJobProcessExit(runtime, identity)
  if (
    physical.state !== 'exited' ||
    physical.proof.kind !== 'exited' ||
    (physical.proof.exit_cause.kind !== 'exited' && worker?.state !== 'failed')
  ) {
    const reason = result.status === 'exited' ? 'physical_exit_proof_missing' : result.reason
    throw new Error(`The settled worker physical exit is unverifiable: ${reason}`)
  }
  return physical.proof
}
