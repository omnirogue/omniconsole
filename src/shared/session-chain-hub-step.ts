import {
  agentStepDoneOperationId,
  agentStepFailedOperationId,
  agentStepOperationId
} from './handoff-operation-ids'

/**
 * How one agent step of a chain shows up in the person's own work tabs.
 *
 * Orcha owns the run; the hub owns the record. A step is mirrored as a handoff thread the owner
 * sends to themselves with action `fyi`, which the hub's attention list deliberately excludes —
 * so the step sits in Waiting For while it runs and nowhere else. Finishing resolves the thread
 * and it leaves both tabs; failing replies on it, which is what puts a broken chain in Needs You.
 */
export const CHAIN_STEP_HANDOFF_ACTION = 'fyi' as const

export type ChainStepHubMirror = {
  /** The thread that stands for this step; absent until the announce succeeded. */
  hubThreadId?: string
  /** When the thread was resolved or replied to, so a restart does not repeat the write. */
  hubSettledAt?: number
}

/** The one-line title of a step's thread: what is running, and where in the chain it sits. */
export function chainStepThreadTitle(input: {
  agent: string
  sessionLabel: string
  position: number
  total: number
}): string {
  const where = input.total > 1 ? ` (${input.position} of ${input.total})` : ''
  return `${input.agent}: ${input.sessionLabel}${where}`.slice(0, 160)
}

/** The body of a step's thread: the instruction it was given, bounded for the hub's 8 KB field. */
export function chainStepThreadBody(input: {
  prompt: string
  workspacePath: string
  hostLabel?: string
}): string {
  const where = input.hostLabel ? `${input.hostLabel}: ${input.workspacePath}` : input.workspacePath
  return [`Running in ${where}.`, '', input.prompt].join('\n').slice(0, 8192)
}

export function chainStepOperationIds(chainId: string, stepId: string, attempt = 1) {
  return {
    announce: agentStepOperationId(chainId, stepId),
    done: agentStepDoneOperationId(chainId, stepId),
    failed: agentStepFailedOperationId(chainId, stepId, attempt)
  }
}
