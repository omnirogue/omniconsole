import { randomUUID } from 'node:crypto'
import { WorkflowTimeoutContinuation } from './workflow-timeout-continuation'
import type { WorkflowProcessReceiptIdentity } from './workflow-process-receipt-identity'
import type { LocalWorkflowRoute } from '../../../shared/local-workflow-seats'
import {
  describeJsonSchemaProblems,
  validateJsonSchema
} from '../../../shared/json-schema-validate'
import type { ProcessResult } from '../../../shared/child-process/process-spec'
import type { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import { WorkflowCacheMissError } from './workflow-cache-miss'
import { workflowCallDigest } from './workflow-call-digest'
import {
  parseWorkflowNativeResult,
  WorkflowAnswerRejectedError,
  WorkflowCallStalledError,
  type NativeResult
} from './workflow-native-result'
import type { WorkflowProgramCall } from './workflow-program-context'
import { assertWorkflowSchemaContract } from './workflow-schema-contract'
import { WorkflowCallLaunchError, workflowAccountFailure } from './workflow-launch-failure'
import type { WorkflowScriptSlots } from './workflow-script-slots'
import type { WorkflowCallBudget } from './workflow-call-budget'
import { admitWorkflowAttempt } from './workflow-attempt-budget'
import {
  runWithWorkflowAccount,
  workflowReceiptCommit,
  WorkflowAttemptUnverifiableError,
  WorkflowHostLostError,
  WorkflowNoLaunchError,
  type WorkflowAttemptAccount
} from './workflow-attempt-outcomes'

export type WorkflowTerminalReceipt = {
  attemptId: string
  processReceiptRef: string
  partialItems?: unknown[]
  liveness: 'exited'
}

export {
  runWithWorkflowAccount,
  WorkflowAttemptUnverifiableError,
  WorkflowHostLostError,
  WorkflowNoLaunchError,
  type WorkflowAttemptAccount
} from './workflow-attempt-outcomes'

export type WorkflowAttemptLaunch = ((input: {
  call: WorkflowProgramCall
  attemptId: string
  ordinal: number
  problems: string | null
  /**
   * Why an earlier attempt's answer was rejected (schema or semantics), if one was. Unlike
   * `problems` it is never an infrastructure fault, so a retry may show it to the model.
   */
  rejection?: string | null
  signal: AbortSignal
  /** Present on budgeted runs: the adapter must hold the call to this reservation. */
  budget?: { reservedUsd: number }
  /** Adapter owns termination even if this callback rejects publication after stop. */
  recordPreparation: (identity: WorkflowProcessReceiptIdentity) => void
  recordLaunch: (processReceiptRef: string) => void
  recordNoLaunch: (reason: string) => void
}) => Promise<{ result: ProcessResult; receipt: WorkflowTerminalReceipt }>) & {
  account?: WorkflowAttemptAccount
}

/** Host injects its shared admission authority and one certified provider adapter. */
export function createDurableWorkflowAgent(input: {
  store: WorkflowCheckpointStore
  executionId: string
  fence: number
  slots: Pick<WorkflowScriptSlots, 'run'>
  signal: AbortSignal
  /** Frozen model/account/effort/policy and validator identities, without credentials. */
  seatFingerprint: (seatId: string) => string
  route: (seatId: string) => LocalWorkflowRoute
  reservation: number
  attemptsPerRun?: number
  cacheOnly?: boolean
  seatFailures?: Map<string, string>
  launch: WorkflowAttemptLaunch
  /** The run's root budget: each attempt is admitted after it is prepared, before it launches. */
  budget?: WorkflowCallBudget
  budgetSeat?: (seatId: string) => { model: string; effort?: string | null; accountId?: string }
  attestNativeResult?: (input: {
    call: WorkflowProgramCall
    attemptId: string
    parsed: NativeResult
  }) => void | Promise<void>
  closeAdmission: (error: Error) => void
}) {
  const seatFailures = input.seatFailures ?? new Map<string, string>()
  return async (call: WorkflowProgramCall): Promise<unknown> => {
    assertWorkflowSchemaContract(call.schema)
    const validate = (value: unknown) => {
      const defects = validateJsonSchema(call.schema, value)
      if (defects.length) {
        throw new Error(describeJsonSchemaProblems(defects))
      }
      const semanticError = call.validateSemantics(value)
      if (semanticError) {
        throw new Error(semanticError)
      }
    }
    const fingerprint = input.seatFingerprint(call.seatId)
    const route = input.route(call.seatId)
    const inputDigest = workflowCallDigest(call, fingerprint, route)
    const withReceipt = workflowReceiptCommit(input.closeAdmission)
    // A replayed saved output is recorded as reuse: no provider call and no attempt.
    const reused = (cached: unknown) => {
      input.budget?.reuse(call.id, randomUUID())
      return cached
    }
    const prepare = (cacheOnly = input.cacheOnly) =>
      input.store.prepare({
        executionId: input.executionId,
        fence: input.fence,
        callId: call.id,
        inputDigest,
        reservation: input.reservation,
        validate,
        cacheOnly
      })
    const account = input.launch.account
    if (account) {
      // An accepted result replays at once instead of waiting for the account.
      input.signal.throwIfAborted()
      try {
        const replayed = prepare(true)
        if ('cached' in replayed) {
          return reused(replayed.cached)
        }
      } catch (cause) {
        if (!(cause instanceof WorkflowCacheMissError)) {
          throw cause
        }
      }
    }
    let problems: string | null = null
    let rejection: string | null = null
    const continuation = new WorkflowTimeoutContinuation(call)
    // Stays true while every attempt failed at launch (workflow-launch-failure.ts).
    let launchOnly = true
    // A stall buys one shorter retry; a second stall ends the call.
    let stalls = 0
    // The persisted store may impose a smaller limit; this is the preset's absolute ceiling.
    const attempts = Math.min(3, input.attemptsPerRun ?? 3)
    for (let index = 0; index < attempts && stalls < 2; index++) {
      const attempt = async () => {
        const prepared = prepare()
        if ('cached' in prepared) {
          return { accepted: true as const, value: reused(prepared.cached) }
        }
        const unavailable = seatFailures.get(call.seatId)
        if (unavailable) {
          input.store.recordNoLaunch(prepared.attemptId, input.fence, unavailable.slice(0, 2048))
          throw new WorkflowCallLaunchError(unavailable)
        }
        const metered = await admitWorkflowAttempt({
          budget: input.budget,
          seat: input.budgetSeat?.(call.seatId),
          attemptId: prepared.attemptId,
          callId: call.id,
          route,
          signal: input.signal,
          refused: (refusal) => {
            input.store.recordNoLaunch(prepared.attemptId, input.fence, refusal.message)
            input.closeAdmission(refusal)
          }
        })
        let launched: Awaited<ReturnType<WorkflowAttemptLaunch>>
        try {
          launched = await input.launch({
            call: continuation.call(),
            ...prepared,
            ...(metered ? { budget: metered.grant } : {}),
            problems,
            rejection,
            signal: input.signal,
            recordPreparation: (identity) =>
              input.store.recordProcessPreparation(prepared.attemptId, input.fence, identity),
            recordLaunch: (ref) => input.store.recordLaunch(prepared.attemptId, input.fence, ref),
            recordNoLaunch: (reason) =>
              input.store.recordNoLaunch(prepared.attemptId, input.fence, reason)
          })
        } catch (cause) {
          if (cause instanceof WorkflowNoLaunchError) {
            await metered?.notSent(cause.message)
            problems = cause.message
            return { accepted: false as const }
          }
          if (cause instanceof WorkflowHostLostError) {
            await (cause.retryMessage
              ? metered?.launched(cause.launched.result, 'failed')
              : metered?.unknown())
            if (!cause.retryMessage) {
              input.closeAdmission(cause)
              throw cause
            }
            withReceipt(() =>
              input.store.settleFailure(
                prepared.attemptId,
                input.fence,
                cause.launched.receipt,
                cause.message
              )
            )
            throw new Error(cause.message, { cause })
          }
          await metered?.unknown()
          const error = new WorkflowAttemptUnverifiableError(
            'Workflow attempt needs exit reconciliation',
            { cause }
          )
          input.closeAdmission(error)
          throw error
        }
        if (input.signal.aborted) {
          await metered?.launched(launched.result, 'cancelled')
          withReceipt(() =>
            input.store.settleFailure(
              prepared.attemptId,
              input.fence,
              launched.receipt,
              'Workflow cancelled before result acceptance'
            )
          )
          input.signal.throwIfAborted()
        }
        let parsed: ReturnType<typeof parseWorkflowNativeResult>
        try {
          parsed = parseWorkflowNativeResult(
            route,
            launched.result,
            call.schema,
            call.validateSemantics,
            call.output,
            continuation.timeoutMs
          )
          await input.attestNativeResult?.({ call, attemptId: prepared.attemptId, parsed })
        } catch (cause) {
          problems = cause instanceof Error ? cause.message : String(cause)
          continuation.retain(launched.result)
          if (cause instanceof WorkflowAnswerRejectedError) {
            rejection = problems
          }
          if (cause instanceof WorkflowCallStalledError) {
            stalls++
          }
          if (workflowAccountFailure(problems)) {
            seatFailures.set(call.seatId, problems)
          }
          if (cause instanceof WorkflowAnswerRejectedError || !workflowAccountFailure(problems)) {
            launchOnly = false
          }
          await metered?.launched(launched.result, 'failed')
          if (
            !withReceipt(() =>
              input.store.settleFailure(
                prepared.attemptId,
                input.fence,
                continuation.receipt(launched.receipt),
                problems!
              )
            )
          ) {
            throw new Error('Workflow attempt settlement rejected')
          }
          return { accepted: false as const }
        }
        await metered?.launched(launched.result, 'ok', parsed.usage, parsed.providerRequestId)
        const receipt = {
          ...launched.receipt,
          providerSessionId: parsed.providerSessionId,
          providerRequestId: parsed.providerRequestId,
          resolvedModels: parsed.resolvedModels,
          usage: parsed.usage
        }
        if (
          !withReceipt(() =>
            input.store.accept(prepared.attemptId, input.fence, parsed.value, receipt, validate)
          )
        ) {
          withReceipt(() =>
            input.store.settleFailure(
              prepared.attemptId,
              input.fence,
              launched.receipt,
              'Result rejected after control intent'
            )
          )
          throw new Error('Workflow result acceptance rejected')
        }
        return { accepted: true as const, value: parsed.value }
      }
      const outcome = await runWithWorkflowAccount(
        input.slots,
        account,
        call,
        attempt,
        input.signal
      )
      if (outcome.accepted) {
        return outcome.value
      }
      if (seatFailures.has(call.seatId)) {
        break
      }
    }
    const message = `Workflow call exhausted its attempts: ${problems}`
    throw launchOnly && problems ? new WorkflowCallLaunchError(message) : new Error(message)
  }
}
