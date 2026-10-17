import { registerConsoleJobObservationReporter } from '../runtime/orchestration/console-job-observation-reporter'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { ConsoleJobPublication, type ConsoleJobPublicationOptions } from './console-job-publication'

type PublicationRuntime = { getOrchestrationDb(): OrchestrationDb }
type PublicationRegistration = { publication: ConsoleJobPublication; dispose(): Promise<void> }
const registrations = new WeakMap<PublicationRuntime, PublicationRegistration>()

export function registerConsoleJobPublication(
  runtime: PublicationRuntime,
  options: Omit<ConsoleJobPublicationOptions, 'db'> & { retryIntervalMs?: number }
): PublicationRegistration {
  const existing = registrations.get(runtime)
  if (existing) {
    return existing
  }
  const publication = new ConsoleJobPublication({ ...options, db: runtime.getOrchestrationDb() })
  const unregister = registerConsoleJobObservationReporter(runtime, (observation) =>
    publication.onCommitted(observation)
  )
  const timer = setInterval(() => {
    void publication.flush()
  }, options.retryIntervalMs ?? 30_000)
  timer.unref()
  const registration = {
    publication,
    async dispose() {
      clearInterval(timer)
      unregister()
      registrations.delete(runtime)
      await publication.dispose()
    }
  }
  registrations.set(runtime, registration)
  void publication.flush()
  return registration
}
