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

export type WorkflowTerminalReceipt = {
  attemptId: string
  processReceiptRef: string
  partialItems?: unknown[]
  liveness: 'exited'
}

/**
 * What a launch shares besides host capacity (an account login). It is asked once the call holds a
 * slot, before an attempt is reserved: it runs `work` under the account (`done`), or reports the
 * account taken, and `busy` settles once it is free again.
 */
export type WorkflowAttemptAccount = <T>(
  call: WorkflowProgramCall,
  work: () => Promise<T>,
  signal: AbortSignal
) => Promise<{ done: T } | { busy: () => Promise<void> }>

/**
 * Takes a slot, then the call's account. While the account is taken the slot goes back and the
 * call waits holding nothing, so it never holds a slot while it waits for an account, nor an
 * account while it waits for a slot. Each try decides afresh, just before the attempt would start.
 */
export async function runWithWorkflowAccount<T>(
  slots: Pick<WorkflowScriptSlots, 'run'>,
  account: WorkflowAttemptAccount | undefined,
  call: WorkflowProgramCall,
  work: () => Promise<T>,
  signal: AbortSignal
): Promise<T> {
  for (;;) {
    const held = await slots.run(
      async () => (account ? account(call, work, signal) : { done: await work() }),
      signal
    )
    if ('done' in held) {
      return held.done
    }
    await held.busy()
  }
}

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
  /** Adapter owns termination even if this callback rejects publication after stop. */
  recordPreparation: (identity: WorkflowProcessReceiptIdentity) => void
  recordLaunch: (processReceiptRef: string) => void
  recordNoLaunch: (reason: string) => void
}) => Promise<{ result: ProcessResult; receipt: WorkflowTerminalReceipt }>) & {
  account?: WorkflowAttemptAccount
}

/** An adapter failure without exit evidence must close admission, not buy another attempt. */
export class WorkflowAttemptUnverifiableError extends Error {}
export class WorkflowNoLaunchError extends Error {}

/**
 * The launch's own process exited (its receipt proves it), but contact with the computer the
 * seat ran on was lost. With `retryMessage`, exit was confirmed and only the call fails.
 * Otherwise the attempt remains pending and closes admission until remote reconciliation.
 */
export class WorkflowHostLostError extends WorkflowAttemptUnverifiableError {
  constructor(
    message: string,
    readonly launched: { result: ProcessResult; receipt: WorkflowTerminalReceipt },
    readonly retryMessage?: string
  ) {
    super(message)
    this.name = 'WorkflowHostLostError'
  }
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
    const withReceipt = <T>(commit: () => T): T => {
      try {
        return commit()
      } catch (cause) {
        const error = new WorkflowAttemptUnverifiableError(
          'Workflow receipt requires reconciliation',
          { cause }
        )
        input.closeAdmission(error)
        throw error
      }
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
          return replayed.cached
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
          return { accepted: true as const, value: prepared.cached }
        }
        const unavailable = seatFailures.get(call.seatId)
        if (unavailable) {
          input.store.recordNoLaunch(prepared.attemptId, input.fence, unavailable.slice(0, 2048))
          throw new WorkflowCallLaunchError(unavailable)
        }
        let launched: Awaited<ReturnType<WorkflowAttemptLaunch>>
        try {
          launched = await input.launch({
            call: continuation.call(),
            ...prepared,
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
            problems = cause.message
            return { accepted: false as const }
          }
          if (cause instanceof WorkflowHostLostError) {
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
          const error = new WorkflowAttemptUnverifiableError(
            'Workflow attempt needs exit reconciliation',
            { cause }
          )
          input.closeAdmission(error)
          throw error
        }
        if (input.signal.aborted) {
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
