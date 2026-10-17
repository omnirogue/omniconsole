import type { PtyLaunchGateReceipt } from '../../../../shared/pty-launch-gate'
import type { OrcaRuntimeService } from '../../omni-runtime'
import type { ConsoleLocalAttempt } from '../../../console-workflows/console-local-execution-schema'
import { startConsoleWorkerProcess } from '../../../console-workflows/console-worker-start-gate'
import {
  requireWorkerAuthority,
  type WorkerEffect,
  type WorkerSetupReceipt
} from './orchestration-worker-topology'

export async function startWorkerConsoleProcess(input: {
  runtime: OrcaRuntimeService
  dispatchId: string
  terminalHandle: string
  worktreeId: string
  effects: WorkerEffect[]
  setup: WorkerSetupReceipt
  gate: PtyLaunchGateReceipt | undefined
  attempt: ConsoleLocalAttempt
}): Promise<void> {
  input.runtime.getOrchestrationDb().prepareStartingWorkerAuthority({
    dispatchId: input.dispatchId,
    handle: input.terminalHandle,
    ...requireWorkerAuthority(input.runtime, input.terminalHandle),
    worktreeId: input.worktreeId,
    effects: input.effects,
    setupState: input.setup.state,
    terminalOwnership: 'created'
  })
  await startConsoleWorkerProcess(input)
}
