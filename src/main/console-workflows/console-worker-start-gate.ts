import { isDeepStrictEqual } from 'node:util'
import {
  isPtyLaunchGateReceipt,
  type PtyLaunchGateReceipt,
  type PtyLaunchGateRequest
} from '../../shared/pty-launch-gate'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import {
  attachConsoleJobStartReceipt,
  getConsoleJobBindingForDispatch
} from '../runtime/orchestration/console-job-binding'
import {
  recordConsoleJobProcessHandshake,
  readConsoleJobProcessHandshake,
  type ConsoleJobProcessIdentity
} from '../runtime/orchestration/console-job-process-handshake'
import {
  consoleLocalAttemptSchema,
  type ConsoleLocalAttempt
} from './console-local-execution-schema'
import type { ConsoleLocalExecutionPort } from './console-local-execution-contract'
import { consoleJobInputDigest } from './console-job-digests'
import { redactConsoleWorkflowMemory } from '../backoffice/console-workflow-credential-memory'
import { resolveConsoleFolderJobWorkspace } from './console-folder-job-workspace'
import { readConsoleJobActivationReceipt } from '../runtime/orchestration/console-job-activation-receipt'
import { mintConsoleLaunchGate } from '../pty/console-launch-authority'

const ports = new WeakMap<OrcaRuntimeService, ConsoleLocalExecutionPort>()
const preparedGates = new WeakMap<
  OrcaRuntimeService,
  Map<string, { gate: PtyLaunchGateRequest; assertPrincipal(): void }>
>()

export function registerConsoleWorkerStartPort(
  runtime: OrcaRuntimeService,
  port: ConsoleLocalExecutionPort
): () => void {
  ports.set(runtime, port)
  return () => {
    if (ports.get(runtime) === port) {
      ports.delete(runtime)
    }
  }
}

function identity(runtime: OrcaRuntimeService, dispatchId: string): ConsoleJobProcessIdentity {
  const db = runtime.getOrchestrationDb()
  const binding = getConsoleJobBindingForDispatch(db, dispatchId)
  const dispatch = db.getDispatchContextById(dispatchId)
  const run = dispatch && db.getRun(dispatch.run_id)
  const activation = run && readConsoleJobActivationReceipt(db, run.id)
  if (
    !binding?.claim ||
    !run?.console_job_principal ||
    run.origin !== 'hub_dispatched' ||
    activation?.jobId !== binding.jobId ||
    activation.activationId !== binding.claim.attemptIntentId
  ) {
    throw new Error('The local process requires its persisted console activation claim.')
  }
  return { runId: run.id, dispatchId, principal: run.console_job_principal, binding }
}

function pendingAttempt(runtime: OrcaRuntimeService, current: ConsoleJobProcessIdentity) {
  const db = runtime.getOrchestrationDb()
  const worker = db.getWorkerDispatch(current.dispatchId)
  const attempt = consoleLocalAttemptSchema.parse(
    worker && JSON.parse(worker.start_options).consoleExecution
  )
  const activation = readConsoleJobActivationReceipt(db, current.runId)!
  if (
    worker?.state !== 'starting' ||
    worker.worktree_id !== attempt.worktreeId ||
    current.binding.sessionId ||
    activation.jobDigest !== attempt.job.digest ||
    attempt.job.id !== current.binding.jobId ||
    attempt.job.taskId !== current.binding.taskId ||
    attempt.job.workflowId !== current.binding.workflowId ||
    attempt.job.placement !== 'local' ||
    readConsoleJobProcessHandshake(db, current)
  ) {
    throw new Error('The local process requires its unchanged, unstarted activation and workspace.')
  }
  return attempt
}

export async function prepareConsoleWorkerLaunchGate(
  runtime: OrcaRuntimeService,
  dispatchId: string
): Promise<PtyLaunchGateRequest> {
  const current = identity(runtime, dispatchId)
  const attempt = pendingAttempt(runtime, current)
  const port = ports.get(runtime)
  const lease = await port?.captureLaunchAuthority?.()
  if (!port?.startProcess || !lease?.isCurrent() || current.principal !== lease.principal) {
    throw new Error('The signed local process start adapter is unavailable for this claim.')
  }
  let gates = preparedGates.get(runtime)
  if (gates?.has(dispatchId)) {
    throw new Error('This Dispatch already prepared a process; inspect its retained receipt.')
  }
  const assertPrincipal = (): void => {
    if (ports.get(runtime) !== port || !lease.isCurrent()) {
      throw new Error('The signed-in person changed; the process gate remains closed.')
    }
  }
  const assertCurrent = (): void => {
    assertPrincipal()
    if (
      !isDeepStrictEqual(identity(runtime, dispatchId), current) ||
      !isDeepStrictEqual(pendingAttempt(runtime, current), attempt)
    ) {
      throw new Error('The stored console activation changed before native process creation.')
    }
  }
  const validate = async (): Promise<void> => {
    if (current.principal !== (await port.principal())) {
      throw new Error('The signed-in person changed; the process gate remains closed.')
    }
    assertCurrent()
  }
  await validate()
  // Recheck after principal lookup: a concurrent caller may have prepared this Dispatch.
  gates = preparedGates.get(runtime) ?? new Map()
  if (gates.has(dispatchId)) {
    throw new Error('This Dispatch already prepared a process; inspect its retained receipt.')
  }
  const gate = mintConsoleLaunchGate({
    taskId: current.binding.taskId,
    worktreeId: attempt.worktreeId,
    cwd: attempt.worktreePath,
    validate,
    assertCurrent
  })
  gates.set(dispatchId, { gate, assertPrincipal })
  preparedGates.set(runtime, gates)
  return gate
}

/** Every side effect follows its committed predecessor; restoring a journal never calls this launch path. */
export async function startConsoleWorkerProcess(args: {
  runtime: OrcaRuntimeService
  dispatchId: string
  terminalHandle: string
  gate: PtyLaunchGateReceipt | undefined
  attempt: ConsoleLocalAttempt
}): Promise<void> {
  const { runtime, dispatchId, terminalHandle, attempt, gate } = args
  const prepared = preparedGates.get(runtime)?.get(dispatchId)
  if (
    !isPtyLaunchGateReceipt(gate) ||
    !prepared ||
    gate.launchId !== prepared.gate.launchId ||
    gate.startupCommandMode !== 'exec' ||
    gate.processKind !== 'pty-shell' ||
    gate.exitObserver !== 'macos-kqueue'
  ) {
    throw new Error('The execution host did not return a closed process gate receipt.')
  }
  if (attempt.job.workspace?.kind === 'folder') {
    const workspace = await resolveConsoleFolderJobWorkspace(
      runtime,
      `id:${attempt.worktreeId}`,
      attempt.job
    )
    if (workspace.path !== attempt.worktreePath) {
      throw new Error('The folder identity changed; the process gate remains closed.')
    }
  }
  const current = identity(runtime, dispatchId)
  const db = runtime.getOrchestrationDb()
  const port = ports.get(runtime)
  if (!port?.startProcess || current.principal !== (await port.principal())) {
    throw new Error('The signed local process start adapter changed before registration.')
  }
  if (port.sanitize(JSON.stringify(gate)) !== JSON.stringify(gate)) {
    throw new Error('The process receipt contains protected data.')
  }
  const record = (event: Parameters<typeof recordConsoleJobProcessHandshake>[2]): void => {
    recordConsoleJobProcessHandshake(db, current, event, redactConsoleWorkflowMemory)
  }
  record({ phase: 'prepared', gate })
  prepared.assertPrincipal()
  const answer = await port.startProcess({
    ...current,
    gate,
    job: attempt.job,
    projectDir: attempt.worktreePath,
    baseSha: attempt.attemptStartSha,
    inputDigest: consoleJobInputDigest(current.binding, attempt.job, attempt.attemptStartSha)
  })
  if (!answer.ok) {
    throw new Error(answer.error.message)
  }
  if (current.principal !== (await port.principal())) {
    throw new Error('The signed-in person changed; the process gate remains closed.')
  }
  attachConsoleJobStartReceipt(db, { ...current, binding: answer.data })
  record({ phase: 'start_acknowledged', gate })
  const startAcknowledgement = readConsoleJobProcessHandshake(db, current)!.startAcknowledgement!
  prepared.assertPrincipal()
  record({
    phase: 'release_intent',
    gate,
    startAcknowledgement
  })
  prepared.assertPrincipal()
  const released = await runtime.releaseTerminalLaunchGate(terminalHandle, {
    gate,
    startAcknowledgement
  })
  record({ phase: 'released', gate, released })
}
