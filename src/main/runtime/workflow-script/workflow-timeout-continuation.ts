import type { ProcessResult } from '../../../shared/child-process/process-spec'
import type { WorkflowProgramCall } from './workflow-program-context'
import type { WorkflowTerminalReceipt } from './workflow-durable-call'
import { workflowCallStalledAfter } from './workflow-native-result'
import { workflowCallTimeoutMs, WORKFLOW_FROZEN_TIMEOUT_MS } from './workflow-call-timeout'
import { workflowPartialItems } from './workflow-partial-items'

/** A shorter retry rechecks saved partial rows; none bypass native final-turn acceptance. */
export class WorkflowTimeoutContinuation {
  timeoutMs: number | undefined
  private items: unknown[] = []
  private interrupted = false

  constructor(private readonly original: WorkflowProgramCall) {
    this.timeoutMs = workflowCallTimeoutMs(original.timeoutMs)
  }

  call(): WorkflowProgramCall {
    return !this.interrupted
      ? this.original
      : {
          ...this.original,
          timeoutMs: this.timeoutMs,
          prompt: `${this.original.prompt}\n\nAn earlier attempt timed out. Re-check and retain these partial reports, then finish within the shorter budget:\n${JSON.stringify(this.items)}`
        }
  }

  retain(result: ProcessResult): void {
    if (!result.timedOut && workflowCallStalledAfter(result) === undefined) {
      return
    }
    this.interrupted = true
    this.items = [
      ...new Map(
        [...this.items, ...workflowPartialItems(result.stdout, this.original)].map((item) => [
          JSON.stringify(item),
          item
        ])
      ).values()
    ]
    this.timeoutMs = Math.max(1, Math.floor((this.timeoutMs ?? WORKFLOW_FROZEN_TIMEOUT_MS) / 2))
  }

  receipt(receipt: WorkflowTerminalReceipt): WorkflowTerminalReceipt {
    return { ...receipt, ...(this.items.length ? { partialItems: this.items } : {}) }
  }
}
