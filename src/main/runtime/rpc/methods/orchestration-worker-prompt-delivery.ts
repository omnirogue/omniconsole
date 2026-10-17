import type { PtyLaunchGateReceipt } from '../../../../shared/pty-launch-gate'
import type { OrcaRuntimeService } from '../../omni-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import type { DispatchContextRow, TaskRow } from '../../orchestration/types'
import { buildDispatchPreamble } from '../../orchestration/preamble'
import type { WorkerStartInput } from './orchestration-worker-start-schema'
import {
  requireWorkerAuthority,
  type WorkerEffect,
  type WorkerSetupReceipt
} from './orchestration-worker-topology'

export async function deliverWorkerDispatchPrompt(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatch: DispatchContextRow
  task: TaskRow
  params: WorkerStartInput
  terminalHandle: string
  worktreeId: string
  effects: WorkerEffect[]
  setup: WorkerSetupReceipt
  consoleGate?: PtyLaunchGateReceipt
  startupStartedAt?: number
  /** The worker's project, resolved for its host (orchestration-worker-project.ts). */
  projectBrief?: string
}) {
  const { runtime, db, dispatch, task, params, terminalHandle, effects, consoleGate } = args
  const authority = requireWorkerAuthority(runtime, terminalHandle)
  if (
    consoleGate &&
    authority.processIncarnation !== `${consoleGate.ptyId}:${consoleGate.incarnationId}`
  ) {
    throw new Error('The registered console process incarnation changed before dispatch.')
  }
  const capability = db.prepareStartingWorkerAuthority({
    dispatchId: dispatch.id,
    handle: terminalHandle,
    ...authority,
    worktreeId: args.worktreeId,
    effects,
    setupState: args.setup.state,
    terminalOwnership: params.terminal ? 'external' : 'created'
  })
  const preamble = buildDispatchPreamble({
    canDispatchSubWorkers: dispatch.depth < runtime.getNestedWorkerMaxDepth(),
    taskId: task.id,
    hubTaskId: dispatch.hub_task_id,
    dispatchId: dispatch.id,
    taskSpec: params.executionBrief ?? task.spec,
    coordinatorHandle: params.from,
    workerHandle: terminalHandle,
    dispatchCapability: capability,
    devMode: params.devMode,
    cliCommand: runtime.getTerminalOrchestrationCliCommand(terminalHandle),
    ...(args.projectBrief ? { projectBrief: args.projectBrief } : {})
  })
  // Why the key: if this dispatch's prompt already landed, a repeat of this call
  // must report that delivery rather than type a second copy at the worker.
  await runtime.sendTerminalAgentPrompt(terminalHandle, preamble, {
    clientMessageId: `worker-dispatch:${dispatch.id}`
  })
  effects.push({ kind: 'dispatch_input', role: 'agent', id: terminalHandle, state: 'accepted' })
  return db.markWorkerDispatchReady(
    dispatch.id,
    effects,
    args.startupStartedAt === undefined
      ? undefined
      : {
          source: 'run-home-monotonic',
          from: 'dispatch-create',
          to: 'dispatch-input-accepted',
          durationMs: performance.now() - args.startupStartedAt
        }
  )
}
