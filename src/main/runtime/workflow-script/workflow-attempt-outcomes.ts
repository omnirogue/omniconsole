import type { ProcessResult } from '../../../shared/child-process/process-spec'
import type { WorkflowProgramCall } from './workflow-program-context'
import type { WorkflowScriptSlots } from './workflow-script-slots'
import type { WorkflowTerminalReceipt } from './workflow-durable-call'
import type { ResolvedLocalWorkflowSeat } from '../../../shared/local-workflow-seats'
import type { NativeResult } from './workflow-native-result'

/** What a host attests about one native result before it is accepted. */
export type WorkflowNativeAttestationInput = {
  route: ResolvedLocalWorkflowSeat['agent']
  seat: ResolvedLocalWorkflowSeat
  executionId: string
  attemptId: string
  parsed: NativeResult
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

/** Commits a receipt; a commit that fails needs reconciliation and closes the run's admission. */
export function workflowReceiptCommit(closeAdmission: (error: Error) => void) {
  return <T>(commit: () => T): T => {
    try {
      return commit()
    } catch (cause) {
      const error = new WorkflowAttemptUnverifiableError(
        'Workflow receipt requires reconciliation',
        { cause }
      )
      closeAdmission(error)
      throw error
    }
  }
}
