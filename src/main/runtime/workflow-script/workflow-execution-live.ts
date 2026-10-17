import type { WorkflowProgramCall } from './workflow-program-context'
import type { WorkflowScriptSlots } from './workflow-script-slots'

/** What the execution service reports about a call before any provider process exists. */
export type WorkflowExecutionLiveHooks = {
  /** The program asked for the call; it waits for a slot. */
  queued: (executionId: string, callId: string, seatId: string) => void
  /** Both slot levels were granted; the store now replays or reserves an attempt. */
  acquired: (executionId: string, callId: string) => void
  /** The durable agent answered (accepted, cached, failed or cancelled). */
  settled: (executionId: string, callId: string) => void
}

type Slots = Pick<WorkflowScriptSlots, 'run'>

/**
 * Builds the program's agent function. Without hooks this is exactly the durable agent; with
 * hooks each call reports waiting, then starting once its slot is granted, then settled.
 */
export function createLiveWorkflowAgent(input: {
  executionId: string
  live?: WorkflowExecutionLiveHooks
  slots: (onAcquired?: () => void) => Slots
  create: (slots: Slots) => (call: WorkflowProgramCall) => Promise<unknown>
}): (call: WorkflowProgramCall) => Promise<unknown> {
  const { executionId, live } = input
  if (!live) {
    return input.create(input.slots())
  }
  return async (call) => {
    live.queued(executionId, call.id, call.seatId)
    try {
      return await input.create(input.slots(() => live.acquired(executionId, call.id)))(call)
    } finally {
      live.settled(executionId, call.id)
    }
  }
}
