import type { OrchestrationExecutionObservation } from '../../../shared/orchestration-execution-observation'
import type { OrchestrationDb } from './db/orchestration-db'

type CommittedObservationReporter = (observation: OrchestrationExecutionObservation) => void
const reporters = new WeakMap<object, CommittedObservationReporter>()

export function registerConsoleJobObservationReporter(
  runtime: object,
  reporter: CommittedObservationReporter
): () => void {
  reporters.set(runtime, reporter)
  return () => {
    if (reporters.get(runtime) === reporter) {
      reporters.delete(runtime)
    }
  }
}

export function routeConsoleJobObservation(
  runtime: object,
  db: OrchestrationDb,
  observation: OrchestrationExecutionObservation
): boolean {
  // A missing reporter retains the journal for recovery; it must never fall through to card comments.
  if (!db.getRun(observation.runId)?.console_job) {
    return false
  }
  reporters.get(runtime)?.(observation)
  return true
}
