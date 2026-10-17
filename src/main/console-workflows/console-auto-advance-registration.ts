import { consoleWorkflowClient } from '../backoffice/console-workflow-client'
import { sanitizeConsoleWorkflowText } from '../backoffice/console-workflow-person'
import type { ConsoleAutoAdvanceStatus } from '../../shared/console-auto-advance'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { ConsoleAutoAdvance } from './console-auto-advance'
import type { ConsoleLocalExecution } from './console-local-execution'

const registrations = new WeakMap<OrcaRuntimeService, ConsoleAutoAdvance>()

/**
 * One auto-advance runner per runtime, bound to the same ConsoleLocalExecution the person's
 * click uses. It never selects a job itself beyond the admitted projection of that workflow.
 */
export function registerConsoleAutoAdvance(
  runtime: OrcaRuntimeService,
  execution: ConsoleLocalExecution
): ConsoleAutoAdvance {
  const existing = registrations.get(runtime)
  if (existing) {
    return existing
  }
  const service = new ConsoleAutoAdvance({
    readWorkflow: (workflowId) => consoleWorkflowClient.getWorkflow({ workflowId }),
    start: (request) => execution.start(request),
    preference: (workflowId) => runtime.getConsoleAutoAdvance(workflowId),
    record: (workflowId, status: ConsoleAutoAdvanceStatus) => {
      runtime.recordConsoleAutoAdvanceStatus(workflowId, status)
    },
    sanitize: sanitizeConsoleWorkflowText,
    warn: (message) => console.warn('[console-auto-advance]', sanitizeConsoleWorkflowText(message))
  })
  registrations.set(runtime, service)
  return service
}

export function getRegisteredConsoleAutoAdvance(
  runtime: OrcaRuntimeService
): ConsoleAutoAdvance | null {
  return registrations.get(runtime) ?? null
}

export function releaseConsoleAutoAdvance(runtime: OrcaRuntimeService): void {
  registrations.get(runtime)?.dispose()
  registrations.delete(runtime)
}
