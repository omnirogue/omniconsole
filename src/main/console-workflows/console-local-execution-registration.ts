import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { registerConsoleJobPublication } from '../backoffice/console-job-publication-registration'
import { publishConsoleExecutionObservation } from '../backoffice/console-workflow-client'
import { createConsoleWorkflowLocalPort } from '../backoffice/console-workflow-local-port'
import { publishConsoleWorkflowResult } from '../backoffice/console-workflow-result-publication'
import {
  getConsolePublicationPrincipal,
  sanitizeConsoleWorkflowText
} from '../backoffice/console-workflow-person'
import {
  readConsoleJobResult,
  recordConsoleJobResult
} from '../runtime/orchestration/console-job-result'
import { ConsoleLocalExecution } from './console-local-execution'
import type { ConsoleAutoAdvance } from './console-auto-advance'
import {
  registerConsoleAutoAdvance,
  releaseConsoleAutoAdvance
} from './console-auto-advance-registration'
import { installConsoleAutoAdvanceRunnerSource } from './console-auto-advance-registry'
import { consoleLocalResultSchema } from './console-local-execution-schema'

const registrations = new Map<
  OrcaRuntimeService,
  { service: ConsoleLocalExecution; dispose(): Promise<void> }
>()

export function getConsoleLocalExecution(runtime: OrcaRuntimeService): ConsoleLocalExecution {
  const existing = registrations.get(runtime)
  if (existing) {
    return existing.service
  }
  const db = runtime.getOrchestrationDb()
  // Why late-bound: the publisher is built before the execution service that auto-advance drives,
  // and auto-advance must never be the thing that keeps a published result from being recorded.
  let autoAdvance: ConsoleAutoAdvance | null = null
  const publisher = registerConsoleJobPublication(runtime, {
    publish: publishConsoleExecutionObservation,
    publishResult: publishConsoleWorkflowResult,
    getPrincipal: getConsolePublicationPrincipal,
    sanitize: sanitizeConsoleWorkflowText,
    warn: (message) => console.warn('[console-workflows]', sanitizeConsoleWorkflowText(message)),
    onResultPublished: (publication) => autoAdvance?.begin(publication.binding.workflowId)
  })
  const service = new ConsoleLocalExecution(runtime, createConsoleWorkflowLocalPort(), {
    read: (dispatchId) => {
      const dispatch = db.getDispatchContextById(dispatchId)
      if (!dispatch) {
        return null
      }
      const result = readConsoleJobResult(db, dispatch.run_id, dispatchId)
      return result ? consoleLocalResultSchema.parse(result.result) : null
    },
    record: (record, result) => {
      const frozen = recordConsoleJobResult(
        db,
        { runId: record.run.id, workerDispatchId: record.worker.dispatch_id, result },
        sanitizeConsoleWorkflowText
      )
      publisher.publication.onCommittedResult(frozen.observation)
    },
    flush: () => publisher.publication.flush()
  })
  autoAdvance = registerConsoleAutoAdvance(runtime, service)
  registrations.set(runtime, {
    service,
    dispose: async () => {
      releaseConsoleAutoAdvance(runtime)
      service.dispose()
      await publisher.dispose()
    }
  })
  return service
}

export async function disposeConsoleLocalExecutions(): Promise<void> {
  const active = [...registrations.values()]
  registrations.clear()
  await Promise.all(active.map((registration) => registration.dispose()))
}

/**
 * Hands the runtime RPC surface a way to reach the runner without importing this module:
 * everything above pulls the backoffice console client, and with it Electron, into any
 * bundle that names it. Called once from the Electron main process; a plain-Node runtime
 * never calls it, so `resolveConsoleAutoAdvanceRunner` stays null there and callers refuse.
 */
export function installConsoleAutoAdvanceRunner(): void {
  installConsoleAutoAdvanceRunnerSource((runtime) =>
    registerConsoleAutoAdvance(runtime, getConsoleLocalExecution(runtime))
  )
}
