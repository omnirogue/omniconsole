import type { OrchestrationWorkerLaunchReceipt } from './orchestration-worker-launch-preferences'

export function federatedUnknownReceipt(
  worker: { dispatch_id: string; state: string; stage: string; last_error: string | null },
  taskId: string,
  serverName: string,
  launch: OrchestrationWorkerLaunchReceipt
): unknown {
  return {
    taskId,
    dispatchId: worker.dispatch_id,
    state: 'outcome_unknown',
    stage: worker.stage,
    server: { name: serverName },
    launch,
    failedStage: worker.stage,
    lastError: worker.last_error,
    effects: [],
    residualResources: [],
    nextCommands: [
      `omni orchestration worker-show --dispatch ${worker.dispatch_id} --json`,
      `omni orchestration worker-abandon --dispatch ${worker.dispatch_id} --json`
    ]
  }
}
