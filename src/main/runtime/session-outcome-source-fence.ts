import type { OrcaRuntimeService } from './omni-runtime'

/** Child workers already belong to a durable set; discovery cannot commission a nested scheduler. */
export function assertSessionOutcomeIndependentSource(
  runtime: OrcaRuntimeService,
  handle: string
): void {
  const db = runtime.getOrchestrationDb()
  const active = db.getActiveDispatchForTerminal(handle)
  const owned = runtime.listSessionChains().some((chain) =>
    chain.outcomeSet?.attempts.some((attempt) => {
      if (active && (attempt.dispatchId === active.id || attempt.taskId === active.task_id)) {
        return true
      }
      return (
        attempt.dispatchId &&
        db.getWorkerDispatch(attempt.dispatchId)?.agent_terminal_handle === handle
      )
    })
  )
  if (owned) {
    throw new Error(
      'This worker already belongs to a committed outcome set. Report evidence to its owner; nested source binding is forbidden.'
    )
  }
}
