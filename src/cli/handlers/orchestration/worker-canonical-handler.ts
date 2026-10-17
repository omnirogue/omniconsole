import type { CommandHandler } from '../../dispatch'
import { getRequiredStringFlag } from '../../flags'
import { printResult } from '../../format'
import { RuntimeClientError, type RuntimeClient } from '../../runtime-client'
import { ORCHESTRATION_CANONICAL_START_BARRIER_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { callOrchestrationMutation } from './mutation-request'
import { resolveCoordinatorTerminalHandle } from './terminal-identity'

type CanonicalWorkerReceipt = {
  runId: string
  taskId: string
  dispatchId: string
  state: string
  stage?: string
  failedStage?: string
  lastError?: string
  warning?: string
  effects: unknown[]
  residualResources: unknown[]
  canonical?: {
    binding: unknown
    processIdentity: unknown
    phase: string
    terminalProof: unknown
  }
}

async function requireCanonicalStartBarrier(client: RuntimeClient): Promise<void> {
  const status = await client.call<RuntimeStatus>('status.get')
  if (
    !status.result.capabilities?.includes(ORCHESTRATION_CANONICAL_START_BARRIER_RUNTIME_CAPABILITY)
  ) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'The connected OmniConsole runtime does not support canonical worker starts. Connect to a supported runtime advertising orchestration-canonical-start-barrier-v1.'
    )
  }
}

function formatCanonicalWorker(worker: CanonicalWorkerReceipt): string {
  const base = `Worker ${worker.dispatchId} [${worker.state}] for ${worker.taskId}`
  if (worker.lastError) {
    return `${base}\n${worker.failedStage ?? worker.stage ?? 'start'}: ${worker.lastError}`
  }
  return worker.warning ? `${base}\nWarning: ${worker.warning}` : base
}

export const ORCHESTRATION_WORKER_CANONICAL_HANDLERS: Record<string, CommandHandler> = {
  'orchestration worker-prepare': async ({ flags, client, cwd, json }) => {
    await requireCanonicalStartBarrier(client)
    const result = await callOrchestrationMutation<CanonicalWorkerReceipt>(
      client,
      flags,
      'orchestration.workerPrepare',
      {
        task: getRequiredStringFlag(flags, 'task'),
        run: getRequiredStringFlag(flags, 'run'),
        from: await resolveCoordinatorTerminalHandle(flags, cwd, client),
        worktree: getRequiredStringFlag(flags, 'worktree'),
        executionFile: getRequiredStringFlag(flags, 'execution-file')
      }
    )
    if (result.result.state !== 'starting' && result.result.state !== 'ready') {
      process.exitCode = 1
    }
    printResult(result, json, formatCanonicalWorker)
  },
  'orchestration worker-execute': async ({ flags, client, json }) => {
    await requireCanonicalStartBarrier(client)
    const result = await callOrchestrationMutation<CanonicalWorkerReceipt>(
      client,
      flags,
      'orchestration.workerExecute',
      {
        dispatch: getRequiredStringFlag(flags, 'dispatch'),
        startReceiptFile: getRequiredStringFlag(flags, 'start-receipt-file')
      }
    )
    if (result.result.state !== 'ready') {
      process.exitCode = 1
    }
    printResult(result, json, formatCanonicalWorker)
  }
}
