import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalBoolean, OptionalString, requiredString } from '../schemas'
import { ORCHESTRATION_RUN_PAGE_LIMIT } from '../../../../shared/orchestration-run-pagination'
import {
  ORCHESTRATION_RUN_QUEUE_DEFAULT_LIMIT,
  ORCHESTRATION_RUN_QUEUE_MAX_LIMIT
} from '../../../../shared/orchestration-run-queue'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { HUB_TASK_ID_PATTERN } from '../../../../shared/omnios-task-binding'
import { admitOrchestrationRun } from '../../orchestration/run-admission'
import { buildRunQueue } from './orchestration-run-queue'
import {
  assertCallerHandleMatchesEvidence,
  resolveOrchestrationCaller
} from './orchestration-run-scope'

const RunCreateParams = z.object({
  objective: requiredString('Missing --objective'),
  from: requiredString('Missing coordinator terminal'),
  hubTaskId: z.string().regex(HUB_TASK_ID_PATTERN).optional(),
  hubStateRevision: z.number().int().nonnegative().optional(),
  // Why: these are refused, never honoured -- see assertNoConsoleJobAdmission.
  // They stay in the schema so a caller that sends them gets the typed refusal
  // below instead of having them silently stripped and appearing to be accepted.
  consoleJob: z.unknown().optional(),
  consoleJobPrincipal: z.unknown().optional()
})

/**
 * Why: a console job binding and its publication principal are admission
 * evidence, and shape validation can never tell an issued one from a fabricated
 * one. Anyone able to call this method could otherwise pair a card they already
 * hold with a hand-written binding, take `origin = 'hub_dispatched'` and slip
 * through the local-start carve-out without the Hub's start receipt. Only the
 * main-only console launch path -- which holds the server's activation response
 * -- may install a binding, so the public surface refuses it outright.
 */
function assertNoConsoleJobAdmission(params: {
  consoleJob?: unknown
  consoleJobPrincipal?: unknown
}): void {
  if (params.consoleJob !== undefined || params.consoleJobPrincipal !== undefined) {
    throw new OrchestrationError(
      'invalid_argument',
      'A console job binding cannot be supplied to run-create. OmniConsole installs it from the server activation it holds. No effects were applied.',
      { effectsApplied: false }
    )
  }
}

const RunUseParams = z.object({
  id: requiredString('Missing --id'),
  from: requiredString('Missing coordinator terminal'),
  takeoverLegacy: OptionalBoolean
})

const RunCurrentParams = z.object({ from: requiredString('Missing coordinator terminal') })
const RunListParams = z.object({
  limit: z.number().int().min(1).max(ORCHESTRATION_RUN_PAGE_LIMIT).optional(),
  cursor: z.string().min(1).optional()
})
const RunShowParams = z.object({
  id: requiredString('Missing --id'),
  from: OptionalString,
  queue: OptionalBoolean,
  limit: z.number().int().min(1).max(ORCHESTRATION_RUN_QUEUE_MAX_LIMIT).optional()
})

export const ORCHESTRATION_RUN_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.runCreate',
    params: RunCreateParams,
    handler: (params, { orchestrationCompatibilityEvidence, runtime }) => {
      assertNoConsoleJobAdmission(params)
      return admitOrchestrationRun({
        runtime,
        objective: params.objective,
        callerTerminalHandle: params.from,
        callerEvidence: orchestrationCompatibilityEvidence,
        hubTaskId: params.hubTaskId,
        hubStateRevision: params.hubStateRevision
      })
    }
  }),
  defineMethod({
    name: 'orchestration.runUse',
    params: RunUseParams,
    handler: (
      params,
      {
        runtime,
        legacyCoordinatorAuthority,
        orchestrationCompatibilityEvidence,
        orchestrationCompatibilityCallerAuthority: callerAuthority
      }
    ) => {
      const paneKey = resolveOrchestrationCaller(runtime, {
        callerTerminalHandle: params.from,
        callerEvidence: orchestrationCompatibilityEvidence,
        callerAuthority,
        requireStablePane: true,
        evidenceAssertedByCaller: true
      })
      if (
        params.takeoverLegacy &&
        (callerAuthority?.terminalHandle !== params.from || callerAuthority.paneKey !== paneKey)
      ) {
        throw new OrchestrationError(
          'legacy_read_only',
          'Legacy takeover must be invoked by the live coordinator agent terminal it will bind. No effects were applied.',
          { effectsApplied: false }
        )
      }
      assertCallerHandleMatchesEvidence(runtime, params.from, orchestrationCompatibilityEvidence)
      const db = runtime.getOrchestrationDb()
      const priorRun = db.getCurrentRunForPane(paneKey)
      const run = db.bindRun({
        runId: params.id,
        coordinatorHandle: params.from,
        coordinatorPaneKey: paneKey,
        coordinatorProcessIncarnation:
          runtime.getTerminalProcessIncarnation(params.from) ?? undefined,
        takeoverLegacy: params.takeoverLegacy,
        legacyCoordinatorAuthority
      })
      if (!run) {
        throw new OrchestrationError(
          'run_not_found',
          `Run ${params.id} was not found or is inspect-only.`
        )
      }
      runtime.cancelMessageWaiters(params.from)
      runtime.cancelMessageWaiters(`run:${params.id}`)
      if (priorRun && priorRun.id !== params.id) {
        runtime.cancelMessageWaiters(`run:${priorRun.id}`)
      }
      return { run, binding: { consumerGeneration: run.consumer_generation } }
    }
  }),
  defineMethod({
    name: 'orchestration.runCurrent',
    params: RunCurrentParams,
    handler: (params, { orchestrationCompatibilityEvidence, runtime }) => {
      const paneKey = resolveOrchestrationCaller(runtime, {
        callerTerminalHandle: params.from,
        callerEvidence: orchestrationCompatibilityEvidence,
        requireStablePane: true
      })
      return { run: runtime.getOrchestrationDb().getCurrentRunForPane(paneKey) ?? null }
    }
  }),
  defineMethod({
    name: 'orchestration.runList',
    params: RunListParams,
    handler: (params, { runtime }) => runtime.getOrchestrationDb().listRuns(params)
  }),
  defineMethod({
    name: 'orchestration.runShow',
    params: RunShowParams,
    handler: async (params, { runtime }) => {
      const run = runtime.getOrchestrationDb().getRun(params.id)
      if (!run) {
        throw new OrchestrationError('run_not_found', `Run ${params.id} was not found.`)
      }
      if (!params.queue) {
        return { run }
      }
      const queue = await buildRunQueue(runtime, {
        runId: run.id,
        limit: params.limit ?? ORCHESTRATION_RUN_QUEUE_DEFAULT_LIMIT
      })
      return { run, queue }
    }
  })
]
