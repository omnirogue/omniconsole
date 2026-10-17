import { z } from 'zod'
import { isPtyLaunchGateReceipt } from '../../../shared/pty-launch-gate'
import type { ConsoleJobBinding } from '../../../shared/console-workflow-types'
import {
  getConsoleJobBindingForDispatch,
  normalizeConsoleJobBinding,
  validateConsoleJobCorrelation
} from './console-job-binding'
import type { OrchestrationDb } from './db/orchestration-db'

export type ConsoleJobProcessIdentity = {
  runId: string
  dispatchId: string
  principal: string
  binding: ConsoleJobBinding
}

const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const integer = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)
const gate = z
  .object({
    version: z.literal(1),
    state: z.literal('closed'),
    launchId: z.string().max(200),
    gateId: z.string().max(200),
    ptyId: z.string().min(1).max(200),
    incarnationId: z.string().max(200),
    pid: positiveInteger,
    processStartTimeMs: positiveInteger,
    processKind: z.enum(['pty-root', 'pty-shell']),
    reportsChildExitStatus: z.boolean(),
    ptyRootPid: positiveInteger.optional(),
    ptyRootProcessStartTimeMs: positiveInteger.optional(),
    exitObserver: z.literal('macos-kqueue').optional(),
    startupCommandMode: z.enum(['shell', 'exec'])
  })
  .strict()
  .refine(isPtyLaunchGateReceipt, 'The prepared gate must identify its exact host process.')

const startAcknowledgement = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const exitCause = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exited'), exitCode: integer.nonnegative() }).strict(),
  z.object({ kind: z.literal('signaled'), signal: positiveInteger }).strict(),
  z.object({ kind: z.literal('operator_close') }).strict()
])
const physicalExit = z
  .object({
    observedAt: z.string().datetime({ offset: true }),
    processExitCode: integer.nullable(),
    exitCause
  })
  .strict()
  .refine(({ processExitCode, exitCause: cause }) => {
    switch (cause.kind) {
      case 'exited':
        return cause.exitCode === processExitCode
      case 'signaled':
        return processExitCode === null || processExitCode === -cause.signal
      case 'operator_close':
        return true
    }
  }, 'Physical process status must agree with its observed cause.')

export const consoleJobProcessPhases = [
  'prepared',
  'start_acknowledged',
  'release_intent',
  'released',
  'exit_intent',
  'physical_exit'
] as const

export const ConsoleJobProcessEventSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('prepared'), gate }).strict(),
  z.object({ phase: z.literal('start_acknowledged'), gate, startAcknowledgement }).strict(),
  z.object({ phase: z.literal('release_intent'), gate, startAcknowledgement }).strict(),
  z
    .object({
      phase: z.literal('released'),
      gate,
      released: z
        .object({ gateId: z.string().max(200), state: z.literal('released'), startAcknowledgement })
        .strict()
    })
    .strict(),
  z.object({ phase: z.literal('exit_intent'), gate }).strict(),
  z.object({ phase: z.literal('physical_exit'), gate, exit: physicalExit }).strict()
])

export type ConsoleJobProcessEvent = z.infer<typeof ConsoleJobProcessEventSchema>
export type ConsoleJobPhysicalExit = z.infer<typeof physicalExit>
export type ConsoleJobProcessEventInput =
  | Exclude<ConsoleJobProcessEvent, { phase: 'start_acknowledged' }>
  | Omit<Extract<ConsoleJobProcessEvent, { phase: 'start_acknowledged' }>, 'startAcknowledgement'>

export type ConsoleJobProcessRecord = {
  identity: ConsoleJobProcessIdentity
  journalCursor: string
  sequence: number
  event: ConsoleJobProcessEvent
}

/** The immutable activation claim remains the journal identity after canonical start attaches IDs. */
export function normalizeConsoleJobProcessIdentity(
  db: OrchestrationDb,
  input: ConsoleJobProcessIdentity
): ConsoleJobProcessIdentity {
  const run = db.getRun(input.runId)
  const dispatch = db.getDispatchContextById(input.dispatchId)
  const current = getConsoleJobBindingForDispatch(db, input.dispatchId)
  const original = run?.console_job
    ? validateConsoleJobCorrelation({
        consoleJob: JSON.parse(run.console_job),
        consoleJobPrincipal: run.console_job_principal ?? undefined,
        hubTaskId: run.hub_task_id ?? undefined
      })
    : null
  const candidate = normalizeConsoleJobBinding(input.binding)
  if (
    !original?.claim?.host.startsWith('local:') ||
    dispatch?.run_id !== input.runId ||
    db.getTask(dispatch.task_id)?.hub_task_id !== original.taskId ||
    run?.console_job_principal !== input.principal ||
    !current ||
    ![JSON.stringify(original), JSON.stringify(current)].includes(JSON.stringify(candidate))
  ) {
    throw new Error(
      'The process journal requires its exact local Run, Dispatch, claim and principal.'
    )
  }
  return {
    runId: input.runId,
    dispatchId: input.dispatchId,
    principal: input.principal,
    binding: original
  }
}
